/**
 * Direct English → Sinhala subtitle translation with Gemini (user-owned multi-key pool).
 *
 * Pipeline (same approach as SinSub Studio / gemini-srt-translator):
 *   1. Only cue id + English text are sent — timestamps never leave this server.
 *   2. Cues go in batches with a little surrounding context, JSON in / JSON out.
 *   3. Each reply is mapped back by id. Good lines are kept; only the bad/missing ids are re-asked.
 *   4. Quota handling: a key that hits its daily limit on a model is parked for that model,
 *      and when every key is parked the next model in the list is used automatically.
 *   5. A line that still fails gets a free Google Translate fallback instead of sinking the subtitle.
 */
import { POLISH_INSTRUCTIONS } from "./ai-prompts";

export { POLISH_INSTRUCTIONS };

type Cue = { index: string; time: string; text: string };
export type Pair = { id: number; en: string; si?: string };
type Log = (message: string) => void;

export class PolishError extends Error {
  constructor(message: string, public readonly blocked = false, public readonly retryAfterSeconds = 0) {
    super(message);
    this.name = "PolishError";
  }
}

/** Gemini said "slow down" (429) or is overloaded (503) / unreachable. `daily` = this key's daily quota for the model is gone. */
export class RateLimitError extends PolishError {
  constructor(public readonly retryAfterMs: number, public readonly status = 429, public readonly daily = false) {
    super(`Gemini HTTP ${status || "network"} — ${daily ? "daily quota used up" : "rate limited"}`, false, Math.ceil(retryAfterMs / 1000));
    this.name = "RateLimitError";
  }
}

/** Translation could not finish. `temporary` = only quota/overload stopped it, so the job retries later from its checkpoint. */
export class FinalReviewError extends Error {
  constructor(
    message: string,
    readonly checked: number,
    readonly total: number,
    readonly cues: Cue[],
    readonly temporary = false,
  ) {
    super(message);
    this.name = "FinalReviewError";
  }
}

export function geminiKeys(env: Record<string, string | undefined> = process.env): string[] {
  const names = Object.keys(env)
    .filter((n) => /^GEMINI_(?:API_)?KEY(?:_\w+)?$/i.test(n))
    .sort((a, b) => {
      const aIsMain = /^GEMINI_(?:API_)?KEY$/i.test(a);
      const bIsMain = /^GEMINI_(?:API_)?KEY$/i.test(b);
      if (aIsMain && !bIsMain) return -1;
      if (!aIsMain && bIsMain) return 1;
      const numA = Number(a.split("_").pop());
      const numB = Number(b.split("_").pop());
      if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB;
      return a.localeCompare(b);
    });
  return [...new Set(names.flatMap((n) => (env[n] ?? "").split(",").map((k) => k.trim()).filter(Boolean)))];
}

/* ------------------------------------------------------------------ */
/* Which lines need Sinhala                                            */
/* ------------------------------------------------------------------ */

const COMMON_ENGLISH_WORDS = new Set([
  "yes", "yeah", "no", "okay", "ok", "hello", "hi", "hey", "thanks", "sorry", "please", "bye", "wow", "oh",
  "wait", "stop", "help", "run", "go", "come", "look", "listen", "what", "why", "how", "who",
  "where", "when", "now", "here", "there", "again", "really", "god", "man", "guys", "dad", "mom", "mum", "sir", "madam",
  "the", "a", "an", "and", "or", "but", "you", "me", "i", "we", "he", "she", "it", "they", "this", "that", "good", "great",
  "fine", "right", "left", "down", "up", "back", "out", "get", "move", "hurry", "quiet", "enough", "never", "always",
  "mr", "mrs", "ms", "dr", "miss", "mister", "lady", "boss", "captain", "doctor", "officer", "detective", "agent",
]);

/** True when the cue is only a name, acronym, number or symbol ("Rachel!", "FBI", "1984"). */
export function isLiteralCue(enText: string): boolean {
  const clean = enText.trim().replace(/^[-–—]\s*/, "");
  if (!clean) return false;
  if (/^[\d\s.,!?:;'"%$\-–—#@&*()\/+]+$/.test(clean)) return true;
  const words = clean.replace(/[.,!?:;'"“”‘’…()]+/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  return words.every((w) => {
    if (/^\d+$/.test(w)) return true;
    if (/^[A-Z]{2,6}s?$/.test(w)) return true;
    return /^[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?$/.test(w) && !COMMON_ENGLISH_WORDS.has(w.toLowerCase());
  });
}

/** True when the English cue has real words that a Sinhala viewer needs translated. */
export function needsSinhala(enText: string): boolean {
  const plain = enText.replace(/<[^>]+>/g, " ").replace(/[♪♫\[\]]/g, " ").trim();
  return /[A-Za-z]{2,}/.test(plain) && !isLiteralCue(plain);
}

/** Cue IDs (1-based) whose output is still English where Sinhala is required. */
export function findUntranslatedCues(english: Cue[], out: Cue[]): number[] {
  const ids: number[] = [];
  english.forEach((cue, i) => {
    if (needsSinhala(cue.text) && !/[\u0D80-\u0DFF]/.test(out[i]?.text ?? "")) ids.push(i + 1);
  });
  return ids;
}

/** Wordless music cue such as "♪♪" — nothing to translate. */
function isWordless(text: string): boolean {
  return !/[A-Za-z0-9]/.test(text.replace(/<[^>]+>/g, ""));
}

// Comprehensive Indic to Sinhala mapping to prevent cross-script model hallucinations (e.g. Telugu "పూర్" -> Sinhala "පූර්")
const INDIC_TO_SINHALA: Record<string, string> = {
  // Telugu (0x0C00 - 0x0C7F)
  "\u0C15": "ක", "\u0C16": "ඛ", "\u0C17": "ග", "\u0C18": "ඝ", "\u0C19": "ඞ",
  "\u0C1A": "ච", "\u0C1B": "ඡ", "\u0C1C": "ජ", "\u0C1D": "ඣ", "\u0C1E": "ඤ",
  "\u0C1F": "ට", "\u0C20": "ඨ", "\u0C21": "ඩ", "\u0C22": "ඪ", "\u0C23": "ණ",
  "\u0C24": "ත", "\u0C25": "ථ", "\u0C26": "ද", "\u0C27": "ධ", "\u0C28": "න",
  "\u0C2A": "ප", "\u0C2B": "ඵ", "\u0C2C": "බ", "\u0C2D": "භ", "\u0C2E": "ම",
  "\u0C2F": "ය", "\u0C30": "ර", "\u0C31": "ර", "\u0C32": "ල", "\u0C33": "ළ",
  "\u0C35": "ව", "\u0C36": "ශ", "\u0C37": "ෂ", "\u0C38": "ස", "\u0C39": "හ",
  "\u0C05": "අ", "\u0C06": "ආ", "\u0C07": "ඉ", "\u0C08": "ඊ", "\u0C09": "උ",
  "\u0C0A": "ඌ", "\u0C0B": "ඍ", "\u0C0E": "එ", "\u0C0F": "ඒ", "\u0C12": "ඔ", "\u0C13": "ඕ",
  "\u0C3E": "ා", "\u0C3F": "ි", "\u0C40": "ී", "\u0C41": "ු", "\u0C42": "ූ",
  "\u0C43": "ෘ", "\u0C46": "ෙ", "\u0C47": "ේ", "\u0C48": "ෛ", "\u0C4A": "ො",
  "\u0C4B": "ෝ", "\u0C4C": "ෞ", "\u0C4D": "්", "\u0C02": "ං", "\u0C03": "ඃ",

  // Tamil (0x0B80 - 0x0BFF)
  "\u0B95": "ක", "\u0B99": "ඞ", "\u0B9A": "ච", "\u0B9E": "ඤ",
  "\u0B9F": "ට", "\u0BA3": "ණ", "\u0BA4": "ත", "\u0BA8": "න",
  "\u0BAA": "ප", "\u0BAE": "ම", "\u0BAF": "ය", "\u0BB0": "ර",
  "\u0BB2": "ල", "\u0BB5": "ව", "\u0BB4": "ළ", "\u0BB3": "ළ",
  "\u0BB1": "ර", "\u0BB7": "ෂ", "\u0BB8": "ස", "\u0BB9": "හ",
  "\u0B85": "අ", "\u0B86": "ආ", "\u0B87": "ඉ", "\u0B88": "ඊ", "\u0B89": "උ",
  "\u0B8A": "ඌ", "\u0B8E": "එ", "\u0B8F": "ඒ", "\u0B92": "ඔ", "\u0B93": "ඕ",
  "\u0BBE": "ා", "\u0BBF": "ි", "\u0BC0": "ී", "\u0BC1": "ු", "\u0BC2": "ූ",
  "\u0BC6": "ෙ", "\u0BC7": "ේ", "\u0BC8": "ෛ", "\u0BCA": "ො", "\u0BCB": "ෝ",
  "\u0BCD": "්", "\u0B82": "ං",

  // Kannada (0x0C80 - 0x0CFF)
  "\u0C95": "ක", "\u0C96": "ඛ", "\u0C97": "ග", "\u0C98": "ඝ", "\u0C99": "ඞ",
  "\u0C9A": "ච", "\u0C9B": "ඡ", "\u0C9C": "ජ", "\u0C9D": "ඣ", "\u0C9E": "ඤ",
  "\u0C9F": "ට", "\u0CA0": "ඨ", "\u0CA1": "ඩ", "\u0CA2": "ඪ", "\u0CA3": "ණ",
  "\u0CA4": "ත", "\u0CA5": "ථ", "\u0CA6": "ද", "\u0CA7": "ධ", "\u0CA8": "න",
  "\u0CAA": "ප", "\u0CAB": "ඵ", "\u0CAC": "බ", "\u0CAD": "භ", "\u0CAE": "ම",
  "\u0CAF": "ය", "\u0CB0": "ර", "\u0CB1": "ර", "\u0CB2": "ල", "\u0CB3": "ළ",
  "\u0CB5": "ව", "\u0CB6": "ශ", "\u0CB7": "ෂ", "\u0CB8": "ස", "\u0CB9": "හ",
  "\u0C85": "අ", "\u0C86": "ආ", "\u0C87": "ඉ", "\u0C88": "ඊ", "\u0C89": "උ",
  "\u0C8A": "ඌ", "\u0C8B": "ඍ", "\u0C8E": "එ", "\u0C8F": "ඒ", "\u0C92": "ඔ", "\u0C93": "ඕ",
  "\u0CBE": "ා", "\u0CBF": "ි", "\u0CC0": "ී", "\u0CC1": "ු", "\u0CC2": "ූ",
  "\u0CC3": "ෘ", "\u0CC6": "ෙ", "\u0CC7": "ේ", "\u0CC8": "ෛ", "\u0CCA": "ො",
  "\u0CCB": "ෝ", "\u0CCC": "ෞ", "\u0CCD": "්", "\u0C82": "ං", "\u0C83": "ඃ",

  // Devanagari (0x0900 - 0x097F)
  "\u0915": "ක", "\u0916": "ඛ", "\u0917": "ග", "\u0918": "ඝ", "\u0919": "ඞ",
  "\u091A": "ච", "\u091B": "ඡ", "\u091C": "ජ", "\u091D": "ඣ", "\u091E": "ඤ",
  "\u091F": "ට", "\u0920": "ඨ", "\u0921": "ඩ", "\u0922": "ඪ", "\u0923": "ණ",
  "\u0924": "ත", "\u0925": "ථ", "\u0926": "ද", "\u0927": "ධ", "\u0928": "න",
  "\u092A": "ප", "\u092B": "ඵ", "\u092C": "බ", "\u092D": "භ", "\u092E": "ම",
  "\u092F": "ය", "\u0930": "ර", "\u0932": "ල", "\u0933": "ළ",
  "\u0935": "ව", "\u0936": "ශ", "\u0937": "ෂ", "\u0938": "ස", "\u0939": "හ",
  "\u0905": "අ", "\u0906": "ආ", "\u0907": "ඉ", "\u0908": "ඊ", "\u0909": "උ",
  "\u090A": "ඌ", "\u090B": "ඍ", "\u090F": "එ", "\u0910": "ඓ", "\u0913": "ඔ", "\u0914": "ඖ",
  "\u093E": "ා", "\u093F": "ි", "\u0940": "ී", "\u0941": "ු", "\u0942": "ූ",
  "\u0943": "ෘ", "\u0947": "ේ", "\u0948": "ෛ", "\u094B": "ෝ", "\u094C": "ෞ",
  "\u094D": "්", "\u0902": "ං", "\u0903": "ඃ",
};

// Every Brahmic Indic Unicode block (Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada,
// Malayalam) shares the same ISCII letter layout, so the Telugu table above maps any of them by offset.
INDIC_TO_SINHALA["\u0C10"] = "ඓ"; INDIC_TO_SINHALA["\u0C14"] = "ඖ";
{
  const blocks = [0x0900, 0x0980, 0x0A00, 0x0A80, 0x0B00, 0x0B80, 0x0C00, 0x0C80, 0x0D00];
  for (const [ch, si] of Object.entries(INDIC_TO_SINHALA)) {
    const offset = ch.charCodeAt(0) - 0x0C00;
    if (offset < 0 || offset >= 0x80) continue;
    for (const base of blocks) {
      const key = String.fromCharCode(base + offset);
      if (!(key in INDIC_TO_SINHALA)) INDIC_TO_SINHALA[key] = si;
    }
  }
}

// Native digits of Indic, Thai, Lao and Myanmar scripts become ASCII digits (e.g. Bengali ১৮ → 18).
{
  const digitBases = [0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0E50, 0x0ED0, 0x1040];
  for (const base of digitBases) for (let d = 0; d < 10; d++) INDIC_TO_SINHALA[String.fromCharCode(base + d)] ??= String(d);
}

// Whitelist: a Sinhala subtitle may contain Sinhala, Latin (names), and script-neutral symbols/marks.
// Any other letter, mark or digit (Telugu, Bengali, Gujarati, Thai, Lao, Myanmar, Greek, Cyrillic, CJK …) is a leak.
const FOREIGN_SCRIPT_SOURCE = "(?![\\p{sc=Latin}\\p{sc=Sinhala}\\p{sc=Common}\\p{sc=Inherited}])[\\p{L}\\p{M}\\p{Nd}]";
const FOREIGN_SCRIPT_TEST = new RegExp(FOREIGN_SCRIPT_SOURCE, "u");
const FOREIGN_SCRIPT_ALL = () => new RegExp(FOREIGN_SCRIPT_SOURCE, "gu");

export function hasForeignScript(text: string): boolean {
  return FOREIGN_SCRIPT_TEST.test(text);
}

/** Counts leaked foreign-script characters and how many of them have no Sinhala equivalent. */
export function countForeignScript(text: string): { total: number; unmapped: number } {
  const found = text.match(FOREIGN_SCRIPT_ALL()) ?? [];
  return { total: found.length, unmapped: found.filter((c) => !INDIC_TO_SINHALA[c]).length };
}

/** Converts leaked Telugu/Tamil/Kannada/Hindi/etc. letters to Sinhala and drops any that have no equivalent. Touches nothing else. */
export function fixForeignScript(text: string): string {
  if (!hasForeignScript(text)) return text;
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (!FOREIGN_SCRIPT_TEST.test(ch)) { out += ch; continue; }
    const si = INDIC_TO_SINHALA[ch] ?? "";
    out += si;
    // A converted virama before ර/ය needs a zero-width joiner to render as Sinhala rakaransaya/yansaya (ප්‍ර, ක්‍ය).
    if (si === "්") {
      const nextRaw = chars[i + 1] ?? "";
      const next = FOREIGN_SCRIPT_TEST.test(nextRaw) ? INDIC_TO_SINHALA[nextRaw] ?? "" : nextRaw;
      if (next === "ර" || next === "ය") out += "\u200D";
    }
  }
  return out.replace(/[^\S\r\n]{2,}/g, " ").replace(/[^\S\r\n]+$/gm, "");
}

export function cleanSinhalaText(text: string): string {
  // Transliterate any leaked non-Sinhala script characters (e.g. Telugu, Tamil, Kannada, Hindi) into Sinhala
  let s = fixForeignScript(text.trim()).trim();
  // Remove space before punctuation marks: "යන්නේ ?" -> "යන්නේ?"
  s = s.replace(/\s+([?!.,;:])/g, "$1");
  // Normalize consecutive spaces into a single space
  s = s.replace(/[^\S\r\n]+/g, " ");
  // Remove spaces inside quotes
  s = s.replace(/“\s+/g, "“").replace(/\s+”/g, "”");
  return s;
}

/* ------------------------------------------------------------------ */
/* Reply validation (tolerant: keep every good line)                   */
/* ------------------------------------------------------------------ */

/**
 * Reads the {id,text} list out of a Gemini reply. Tries, in order: the reply as-is, the reply without a
 * ``` fence, the part between the first "{"/"[" and the last "}"/"]" (drops chatty text around the JSON),
 * and finally every complete {"id":…,"text":"…"} object it can find, so a cut-off reply still keeps its finished lines.
 */
export function readReplyEntries(raw: string): unknown[] {
  const text = raw.trim();
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const candidates = [text, unfenced];
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      const list = value && typeof value === "object" && "cues" in value ? (value as { cues: unknown }).cues : value;
      if (Array.isArray(list)) return list;
    } catch {
      /* try the next shape */
    }
  }
  const salvaged: unknown[] = [];
  const objectRe = /\{\s*"id"\s*:\s*"?(\d+)"?\s*,\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/g;
  for (const m of text.matchAll(objectRe)) {
    try {
      salvaged.push({ id: Number(m[1]), text: JSON.parse(m[2]!) as string });
    } catch {
      /* skip a broken object */
    }
  }
  return salvaged;
}

/** Returns the usable translations by id; ids that are missing, empty, English-only or in another script are left out. */
export function parseTranslations(targets: Pair[], raw: string): Map<number, string> {
  const result = new Map<number, string>();
  const sourceById = new Map(targets.map((t) => [t.id, t.en]));
  const entries = readReplyEntries(raw);
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const id = Number((entry as { id?: unknown }).id);
    const rawText = (entry as { text?: unknown }).text;
    const en = sourceById.get(id);
    if (en === undefined || result.has(id) || typeof rawText !== "string") continue;
    // A stray leaked letter is repaired; whole words in another script mean this line is asked again.
    const foreign = countForeignScript(rawText);
    if (foreign.unmapped > 0 || foreign.total > 3) continue;
    const text = cleanSinhalaText(rawText);
    if (!text || /-->|```/.test(text)) continue;
    const hasSinhala = /[\u0D80-\u0DFF]/.test(text);
    if (!hasSinhala && needsSinhala(en)) continue;
    if (!hasSinhala && !isLiteralCue(en) && !isWordless(en) && /[A-Za-z]{2,}/.test(en)) continue;
    result.set(id, text);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Model list + one Gemini request                                     */
/* ------------------------------------------------------------------ */

/**
 * Flash-Lite first: on these free keys it has a large daily quota and answers in seconds, while full Flash
 * models allow only ~20 requests per key per day (measured live: gemini-3.8-flash returned 429/timeouts on all keys).
 * The old GEMINI_POLISH_MODEL setting is intentionally ignored; set GEMINI_MODEL_ORDER="a,b,c" to change the order.
 */
export const DEFAULT_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.8-flash",
  // Google's catalog exposes Gemini 3 Flash under its preview ID.
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
];

export function modelPriority(env: Record<string, string | undefined> = process.env): string[] {
  const custom = (env["GEMINI_MODEL_ORDER"] ?? "").split(",").map((m) => m.trim()).filter((m) => /^gemini-[a-z0-9.-]+$/.test(m));
  return custom.length ? [...new Set(custom)] : DEFAULT_MODELS;
}

const REQUEST_TIMEOUT_MS = 90_000;

function retryAfterMsFrom(response: Response, body: any): number {
  const header = response.headers.get("retry-after");
  let seconds = header ? Number(header) || Math.ceil((Date.parse(header) - Date.now()) / 1000) : 0;
  const delay = (body?.error?.details ?? []).find((d: any) => typeof d?.retryDelay === "string")?.retryDelay;
  if (delay) seconds = Math.max(seconds, Number.parseFloat(delay) || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/** True when a 429 means "daily limit for this key+model is used up" (not a short per-minute throttle). */
function isDailyQuota(body: any, retryAfterMs: number): boolean {
  const ids = (body?.error?.details ?? []).flatMap((d: any) => (d?.violations ?? []).map((v: any) => String(v?.quotaId ?? "")));
  if (ids.some((id: string) => /PerDay/i.test(id))) return true;
  return retryAfterMs > 5 * 60_000;
}

/**
 * One request: translate `targets` (id + English only) with `model` on `key`. Returns the raw JSON text.
 * Throws RateLimitError for 429/503/timeouts/network drops, PolishError(blocked) for a bad key or refused request.
 */
export async function generatePolish(
  key: string,
  targets: Pair[],
  context: Pair[],
  signal: AbortSignal,
  _log: Log = () => {},
  _strict = false,
  model = modelPriority()[0]!,
): Promise<string> {
  const lines = targets.map(({ id, en }) => ({ id, en }));
  const ctx = context.map(({ id, en }) => ({ id, en }));
  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: POLISH_INSTRUCTIONS }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify({ context: ctx, lines }) }] }],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: "application/json",
          responseSchema: { type: "OBJECT", properties: { cues: { type: "ARRAY", items: {
            type: "OBJECT", properties: { id: { type: "INTEGER" }, text: { type: "STRING" } }, required: ["id", "text"],
          } } }, required: ["cues"] },
        },
      }),
    });
  } catch (error) {
    if (signal.aborted) throw new PolishError("Translation cancelled");
    // Timeout or dropped connection: let the pool try another key.
    throw new RateLimitError(10_000, 0);
  }
  if (response.status === 429 || response.status === 503 || response.status === 500 || response.status === 504) {
    const body = await response.json().catch(() => null);
    const retryAfterMs = retryAfterMsFrom(response, body);
    const daily = response.status === 429 && isDailyQuota(body, retryAfterMs);
    throw new RateLimitError(Math.max(response.status === 429 ? 15_000 : 5_000, retryAfterMs), response.status, daily);
  }
  if (!response.ok) {
    await response.body?.cancel();
    // 400 for a model name the key cannot use, 401/403 bad key: never retry on this key+model.
    throw new PolishError(`Gemini HTTP ${response.status} on ${model}`, true);
  }
  const body = await response.json();
  const candidate = body.candidates?.[0];
  const text = candidate?.content?.parts?.filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  // A cut-off (MAX_TOKENS) reply still contains usable lines only if it parses; let the caller decide.
  if (!text && (body.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY")) {
    throw new PolishError("Gemini refused this batch", false);
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Key/model pool                                                      */
/* ------------------------------------------------------------------ */

type Generate = (key: string, targets: Pair[], context: Pair[], signal: AbortSignal, model: string) => Promise<string>;

const DAY_MS = 86_400_000;
/** Remembered across runs in the same process so a daily-exhausted key+model is not retried every batch. */
const parkedUntil = new Map<string, number>();

export function resetGeminiPoolState() {
  parkedUntil.clear();
}

class QuotaExhausted extends Error {}

class KeyPool {
  private cooling = new Map<string, number>();
  private strikes = new Map<string, number>();
  private deadKeys = new Set<string>();
  private announced = new Set<string>();
  constructor(readonly keys: string[], readonly models: string[], private log: Log) {}

  private slot(model: string, key: string) { return `${model}|${key}`; }
  private isParked(model: string, key: string, now: number) {
    return this.deadKeys.has(key) || (parkedUntil.get(this.slot(model, key)) ?? 0) > now;
  }

  /** First model that still has at least one usable key. */
  currentModel(now = Date.now()): string | undefined {
    for (const model of this.models) {
      if (this.keys.some((k) => !this.isParked(model, k, now))) {
        if (!this.announced.has(model)) {
          this.announced.add(model);
          this.log(`  using model ${model}`);
        }
        return model;
      }
    }
    return undefined;
  }

  /** Picks a key for `model`, preferring `preferred` (the worker's own key); waitMs > 0 when all usable keys are cooling. */
  pick(model: string, preferred: number): { key?: string; index: number; waitMs: number } {
    const now = Date.now();
    let soonest = Infinity, soonestIdx = preferred;
    for (let i = 0; i < this.keys.length; i++) {
      const index = (preferred + i) % this.keys.length;
      const key = this.keys[index]!;
      if (this.isParked(model, key, now)) continue;
      const until = this.cooling.get(this.slot(model, key)) ?? 0;
      if (until <= now) return { key, index, waitMs: 0 };
      if (until < soonest) { soonest = until; soonestIdx = index; }
    }
    if (!Number.isFinite(soonest)) return { index: preferred, waitMs: -1 };
    return { index: soonestIdx, waitMs: soonest - now };
  }

  ok(model: string, key: string) { this.strikes.delete(this.slot(model, key)); }

  fail(model: string, key: string, error: unknown) {
    const slot = this.slot(model, key);
    const tail = `key …${key.slice(-4)}`;
    if (error instanceof RateLimitError) {
      const strikes = (this.strikes.get(slot) ?? 0) + 1;
      this.strikes.set(slot, strikes);
      // Daily limit, three 429s in a row, or two timeouts/overloads in a row on the same key+model:
      // park it so we stop wasting time and requests on it.
      if (error.daily || (error.status === 429 && strikes >= 3) || (error.status !== 429 && strikes >= 2)) {
        parkedUntil.set(slot, Date.now() + (error.daily ? DAY_MS : 60 * 60_000));
        const why = error.daily ? "daily limit reached" : error.status === 429 ? "keeps rate-limiting" : "keeps timing out / overloaded";
        this.log(`  ${model} ${why} on ${tail} — skipping it for this model`);
        return;
      }
      this.cooling.set(slot, Date.now() + Math.min(error.retryAfterMs, 60_000));
      return;
    }
    if (error instanceof PolishError && error.blocked) {
      // Bad key (401/403) is dead for every model; a 400/404 means this model is unavailable for the key.
      if (/HTTP 40[13]/.test(error.message)) { this.deadKeys.add(key); this.log(`  ${tail} rejected by Google — removed for this run`); }
      else { parkedUntil.set(slot, Date.now() + DAY_MS); this.log(`  ${model} not available on ${tail}`); }
      return;
    }
    this.cooling.set(slot, Date.now() + 3_000);
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new PolishError("Translation cancelled")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new PolishError("Translation cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Sends one batch through the pool, rotating keys and falling back across models until it gets a reply. */
async function requestWithPool(pool: KeyPool, targets: Pair[], context: Pair[], signal: AbortSignal, generate: Generate, worker: { keyIndex: number; id: number; chunk: number }, log: Log): Promise<string> {
  const range = `cues ${targets[0]?.id}-${targets.at(-1)?.id}`;
  for (let attempt = 0; attempt < 400; attempt++) {
    if (signal.aborted) throw new PolishError("Translation cancelled");
    const model = pool.currentModel();
    if (!model) throw new QuotaExhausted("Every Gemini key has used its daily quota on every model");
    const pick = pool.pick(model, worker.keyIndex);
    if (pick.waitMs < 0) continue; // model just ran out of keys; currentModel moves on
    if (!pick.key) {
      log(`  all keys busy on ${model}; waiting ${Math.ceil(pick.waitMs / 1000)}s (${range})`);
      await wait(Math.min(pick.waitMs, 30_000), signal);
      continue;
    }
    worker.keyIndex = pick.index;
    try {
      const raw = await generate(pick.key, targets, context, signal, model);
      pool.ok(model, pick.key);
      return raw;
    } catch (error) {
      if (signal.aborted) throw new PolishError("Translation cancelled");
      pool.fail(model, pick.key, error);
      if (error instanceof RateLimitError || (error instanceof PolishError && error.blocked)) {
        log(`@@worker_retry:${worker.id}:${worker.chunk}`);
        worker.keyIndex = (pick.index + 1) % pool.keys.length;
        continue;
      }
      throw error;
    }
  }
  throw new QuotaExhausted("Gemini kept refusing requests");
}

/* ------------------------------------------------------------------ */
/* Main entry                                                           */
/* ------------------------------------------------------------------ */

export type TranslateOptions = {
  keys?: string[] | undefined;
  models?: string[] | undefined;
  generate?: Generate | undefined;
  chunkSize?: number | undefined;
  maxWorkers?: number | undefined;
  pauseMs?: number | undefined;
  cachedCues?: Record<string | number, string> | Map<number, string> | undefined;
  onChunkDone?: ((cues: [number, string][]) => void) | undefined;
  /** Free per-line fallback (Google Translate) for lines Gemini still gets wrong. */
  fallbackTranslate?: ((text: string) => Promise<string>) | undefined;
  /** Stop with NEEDS_REVIEW when more than this share of spoken lines is still English. */
  maxUntranslatedShare?: number | undefined;
};

/**
 * Translates English cues to spoken Sinhala. Cue index/time are copied from the English cues and never sent to Gemini.
 * `_base` (an older draft) is ignored — Gemini translates directly from English.
 */
export async function polishCues(english: Cue[], _base: Cue[], log: Log, options: TranslateOptions = {}): Promise<Cue[]> {
  if (!english.length) throw new PolishError("Subtitle has no cues");
  const keys = [...new Set(options.keys ?? geminiKeys())];
  if (!keys.length) throw new PolishError("Gemini translation needs GEMINI_API_KEY (or GEMINI_API_KEY_1, _2, …)", true);
  const generate: Generate = options.generate ?? ((key, targets, context, signal, model) => generatePolish(key, targets, context, signal, log, false, model));
  const pool = new KeyPool(keys, options.models ?? modelPriority(), log);
  const pairs: Pair[] = english.map((cue, i) => ({ id: i + 1, en: cue.text }));
  const out: Cue[] = english.map((cue) => ({ ...cue }));
  const doneIds = new Set<number>();

  const cached = options.cachedCues instanceof Map
    ? options.cachedCues
    : new Map(Object.entries(options.cachedCues ?? {}).map(([k, v]) => [Number(k), v]));
  const todo: Pair[] = [];
  let restored = 0;
  for (const pair of pairs) {
    const cachedText = cached.get(pair.id)?.trim();
    if (isWordless(pair.en) || !pair.en.trim()) {
      doneIds.add(pair.id);
    } else if (cachedText && (/[\u0D80-\u0DFF]/.test(cachedText) || !needsSinhala(pair.en))) {
      out[pair.id - 1]!.text = cleanSinhalaText(cachedText);
      doneIds.add(pair.id);
      restored++;
    } else {
      todo.push(pair);
    }
  }
  if (restored) log(`  resumed: ${restored} line(s) already translated earlier`);

  const configuredWorkers = Number(process.env["GEMINI_MAX_WORKERS"]) || 6;
  const configuredChunk = Number(process.env["GEMINI_CHUNK_SIZE"]) || 60;
  const chunkSize = Math.max(1, Math.min(150, options.chunkSize ?? configuredChunk));
  const chunks: Pair[][] = [];
  for (let i = 0; i < todo.length; i += chunkSize) chunks.push(todo.slice(i, i + chunkSize));
  const workers = Math.max(1, Math.min(keys.length, chunks.length || 1, options.maxWorkers ?? configuredWorkers));

  log("@@step:polish");
  log(`@@polish_init:${chunks.length}:${workers}:${pairs.length}`);
  log(`@@pct:${doneIds.size}/${pairs.length}`);
  log(`  Gemini translation: ${todo.length} line(s) in ${chunks.length} batch(es), ${workers} worker(s), ${keys.length} key(s)`);

  const controller = new AbortController();
  let next = 0;
  let quotaStop: QuotaExhausted | undefined;
  let fatal: unknown;
  let fallbackLines = 0;

  const translateChunk = async (chunk: Pair[], worker: { keyIndex: number; id: number; chunk: number }) => {
    const first = chunk[0]!.id, last = chunk.at(-1)!.id;
    const context = [...pairs.slice(Math.max(0, first - 4), first - 1), ...pairs.slice(last, last + 3)];
    let pending = chunk;
    // First try + up to two re-asks of only the lines that came back missing or wrong.
    for (let round = 0; round < 3 && pending.length; round++) {
      let raw = "";
      try {
        raw = await requestWithPool(pool, pending, round === 0 ? context : pairs.slice(Math.max(0, pending[0]!.id - 4), pending[0]!.id - 1), controller.signal, generate, worker, log);
      } catch (error) {
        if (error instanceof QuotaExhausted || controller.signal.aborted) throw error;
        // Refused or unreadable reply: treat as "nothing usable" and re-ask / fall back for these lines only.
        log(`  batch reply unusable (${(error as Error)?.message ?? error}) — cues ${first}-${last}`);
      }
      const got = parseTranslations(pending, raw);
      for (const [id, text] of got) { out[id - 1]!.text = text; doneIds.add(id); }
      pending = pending.filter((p) => !got.has(p.id));
      if (pending.length && round < 2) log(`  ${pending.length} line(s) came back wrong — asking again (cues ${first}-${last})`);
    }
    for (const p of pending) {
      let text = "";
      if (options.fallbackTranslate) {
        try { text = cleanSinhalaText(fixForeignScript(await options.fallbackTranslate(p.en))); } catch { text = ""; }
      }
      out[p.id - 1]!.text = text && /[\u0D80-\u0DFF]/.test(text) ? text : p.en;
      doneIds.add(p.id);
      fallbackLines++;
    }
    options.onChunkDone?.(chunk.map((p) => [p.id, out[p.id - 1]!.text] as [number, string]));
  };

  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const worker = { keyIndex: w % keys.length, id: w + 1, chunk: 0 };
    while (next < chunks.length && !controller.signal.aborted) {
      const chunkIdx = next++;
      const chunk = chunks[chunkIdx]!;
      worker.chunk = chunkIdx;
      log(`@@worker_start:${worker.id}:${chunkIdx}:${chunk[0]!.id}:${chunk.at(-1)!.id}`);
      try {
        await translateChunk(chunk, worker);
      } catch (error) {
        if (error instanceof QuotaExhausted) quotaStop ??= error;
        else fatal ??= error;
        controller.abort();
        break;
      }
      log(`@@worker_done:${worker.id}:${chunkIdx}:${chunk[0]!.id}:${chunk.at(-1)!.id}:${doneIds.size}`);
      log(`@@pct:${doneIds.size}/${pairs.length}`);
      log(`  translated ${doneIds.size}/${pairs.length} lines`);
      if (next < chunks.length) {
        log(`@@worker_idle:${worker.id}`);
        if (options.pauseMs !== 0) await wait(options.pauseMs ?? 1000, controller.signal).catch(() => {});
      }
    }
    log(`@@worker_complete:${worker.id}`);
  }));

  if (quotaStop) {
    const finished = doneIds.size;
    throw new FinalReviewError(`${quotaStop.message}; ${finished}/${pairs.length} lines saved, the rest continue when quota resets`, finished, pairs.length, out, true);
  }
  if (fatal) throw fatal instanceof PolishError ? fatal : new PolishError(`Gemini translation failed: ${(fatal as Error)?.message ?? fatal}`);

  log("@@polish_complete");
  if (fallbackLines) log(`  ${fallbackLines} line(s) used the Google Translate fallback`);
  for (const cue of out) if (hasForeignScript(cue.text)) cue.text = fixForeignScript(cue.text);

  const spoken = english.filter((c) => needsSinhala(c.text)).length;
  const missing = findUntranslatedCues(english, out);
  const share = options.maxUntranslatedShare ?? 0.03;
  if (missing.length > Math.max(2, spoken * share)) {
    throw new FinalReviewError(`${missing.length} line(s) are still English (e.g. #${missing.slice(0, 8).join(", #")}) — please review before publishing`, spoken - missing.length, spoken, out, false);
  }
  log(`  ✓ Sinhala translation done: ${spoken - missing.length}/${spoken} spoken lines in Sinhala, timestamps untouched`);
  return out;
}
