import { unzipSync, strFromU8 } from "fflate";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { FinalReviewError, fixForeignScript, geminiKeys, hasForeignScript, polishCues, PolishError } from "./gemini-polish.server";

export type Settings = {
  minPopularity: number;
  minVoteCount: number;
  minRating: number;
  minRuntime: number;
  lookaheadDays: number;
  maxBatchSize: number;
  maxScanJobs: number;
  retryHours: number;
  maxAttempts: number;
  embedProbeUrl: string;
  bucket: string;
  revalidateUrl: string;
  seriesTypeValue: string;
  myMemoryEmail: string;
  wyzieApiKey: string;
  subdlApiKey: string;
};

export const DEFAULT_SETTINGS: Settings = {
  minPopularity: 20,
  minVoteCount: 5,
  minRating: 7.0,
  minRuntime: 60,
  lookaheadDays: 30,
  maxBatchSize: 5,
  maxScanJobs: 10,
  retryHours: 6,
  maxAttempts: 10,
  embedProbeUrl: "",
  bucket: "subtitles",
  revalidateUrl: "",
  seriesTypeValue: "tv_show",
  myMemoryEmail: "",
  wyzieApiKey: "",
  subdlApiKey: "",
};

export const STATUSES = [
  "upcoming",
  "waiting_embed",
  "waiting_subtitle",
  "processing",
  "completed",
  "failed",
] as const;

const EXCLUDED_TV_GENRES = [10767, 10763, 10764]; // talk, news, reality

export function envStatus() {
  const keys = [
    "ONFLIX_SUPABASE_URL",
    "ONFLIX_SUPABASE_SERVICE_KEY",
    "TMDB_API_KEY",
    "TAVILY_API_KEY",
    "GEMINI_API_KEY",
    "CRON_SECRET",
    "REVALIDATE_SECRET",
    "MYMEMORY_USER_EMAIL",
    "WYZIE_API_KEY",
    "SUBDL_API_KEY",
  ];
  return Object.fromEntries([...new Set([...keys, ...Object.keys(process.env).filter((k) => /^GEMINI_(?:API_)?KEY(?:_\w+)?$/i.test(k))])]
    .map((k) => [k, k === "GEMINI_API_KEY" ? geminiKeys().length > 0 : !!process.env[k]]));
}

export function db(): SupabaseClient {
  const url = process.env["ONFLIX_SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
  const key = process.env["ONFLIX_SUPABASE_SERVICE_KEY"] || process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("ONFLIX_SUPABASE_URL / ONFLIX_SUPABASE_SERVICE_KEY not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

export function checkSecret(provided: string | null | undefined) {
  const s = process.env["CRON_SECRET"];
  if (!s) throw new Error("CRON_SECRET not configured");
  if (!provided || provided.length !== s.length) return false;
  let diff = 0;
  for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

export async function getSettings(): Promise<Settings> {
  const { data } = await db().from("subtitle_automation_settings").select("settings").eq("id", 1).maybeSingle();
  return { ...DEFAULT_SETTINGS, ...((data?.settings as Partial<Settings>) ?? {}) };
}

export async function saveSettings(s: Settings) {
  const { error } = await db()
    .from("subtitle_automation_settings")
    .upsert({ id: 1, settings: s, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export async function tmdb(path: string, params: Record<string, string> = {}) {
  const key = process.env["TMDB_API_KEY"];
  if (!key) throw new Error("TMDB_API_KEY not configured");
  const isBearer = key.length > 40;
  const u = new URL(`https://api.themoviedb.org/3${path}`);
  if (!isBearer) u.searchParams.set("api_key", key);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: isBearer ? { Authorization: `Bearer ${key}` } : {} });
  if (!r.ok) throw new Error(`TMDB ${path} ${r.status}`);
  return r.json();
}

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

type Log = (m: string) => void;

export function passesQuality(
  item: { popularity?: number; vote_count?: number; vote_average?: number },
  s: Pick<Settings, "minPopularity" | "minVoteCount" | "minRating">,
) {
  if ((item.popularity ?? 0) < s.minPopularity) return false;
  if ((item.vote_count ?? 0) < s.minVoteCount) return false;
  if ((item.vote_average ?? 0) < s.minRating) return false;
  return true;
}

/* ---------------- Stage 1: Scanner ---------------- */
export async function runScan(log: Log = () => {}) {
  const s = await getSettings();
  const sb = db();
  await syncTrending(sb, log);
  const horizon = addDays(s.lookaheadDays);
  const now = today();
  let inserted = 0, skipped = 0;

  const lists = await Promise.all([
    tmdb("/trending/movie/week"),
    tmdb("/movie/upcoming", { region: "US" }),
    tmdb("/movie/now_playing"),
    tmdb("/trending/tv/week"),
    tmdb("/tv/on_the_air"),
  ]);
  const movieIds = new Set<number>();
  const tvIds = new Set<number>();
  lists.slice(0, 3).forEach((l) => l.results?.forEach((m: any) => movieIds.add(m.id)));
  lists.slice(3).forEach((l) => l.results?.forEach((t: any) => tvIds.add(t.id)));
  log(`Discovered ${movieIds.size} movies, ${tvIds.size} series`);

  const candidates: any[] = [];

  for (const id of movieIds) {
    const m = await tmdb(`/movie/${id}`);
    if (!passesQuality(m, s)) { skipped++; continue; }
    if (!m.runtime || m.runtime < s.minRuntime) { skipped++; continue; }
    if (!m.release_date || m.release_date > horizon) { skipped++; continue; }
    candidates.push({
      tmdb_id: m.id, media_type: "movie", title: m.title, season_number: 0, episode_number: 0,
      release_date: m.release_date, popularity: m.popularity, runtime: m.runtime, poster_path: m.poster_path,
    });
  }

  for (const id of tvIds) {
    const t = await tmdb(`/tv/${id}`);
    const genres: number[] = (t.genres ?? []).map((g: any) => g.id);
    if (genres.some((g) => EXCLUDED_TV_GENRES.includes(g))) { skipped++; continue; }
    if (!passesQuality(t, s)) { skipped++; continue; }
    for (const ep of [t.last_episode_to_air, t.next_episode_to_air]) {
      if (!ep?.air_date || ep.air_date > horizon) continue;
      candidates.push({
        tmdb_id: t.id, media_type: "tv", title: `${t.name} S${ep.season_number}E${ep.episode_number}`,
        season_number: ep.season_number, episode_number: ep.episode_number, release_date: ep.air_date,
        popularity: t.popularity, runtime: ep.runtime ?? null, poster_path: t.poster_path,
      });
    }
  }

  // Skip items that already have a completed Sinhala subtitle in OnFlix
  const { data: existing } = await sb
    .from("subtitle_automation_jobs")
    .select("tmdb_id,media_type,season_number,episode_number")
    .in("tmdb_id", [...new Set(candidates.map((c) => c.tmdb_id))]);
  const keyOf = (c: any) => `${c.media_type}:${c.tmdb_id}:${c.season_number}:${c.episode_number}`;
  const known = new Set((existing ?? []).map(keyOf));
  const { data: done } = await sb
    .from("content")
    .select("tmdb_id,sinhala_subtitle_url")
    .in("tmdb_id", candidates.filter((c) => c.media_type === "movie").map((c) => c.tmdb_id))
    .not("sinhala_subtitle_url", "is", null);
  const doneMovies = new Set((done ?? []).map((d: any) => d.tmdb_id));

  // Skip TV episodes that already exist in OnFlix episodes (by content.id + season + episode)
  const tvTmdb = [...new Set(candidates.filter((c) => c.media_type === "tv").map((c) => c.tmdb_id))];
  const existingEps = new Set<string>();
  if (tvTmdb.length) {
    const { data: tvContent } = await sb.from("content").select("id,tmdb_id").in("tmdb_id", tvTmdb);
    const tmdbByContent = new Map((tvContent ?? []).map((r: any) => [r.id, Number(r.tmdb_id)]));
    if (tmdbByContent.size) {
      const { data: eps } = await sb
        .from("episodes")
        .select("content_id,season,episode")
        .in("content_id", [...tmdbByContent.keys()]);
      for (const e of eps ?? []) {
        existingEps.add(`${tmdbByContent.get(e.content_id)}:${Number(e.season)}:${Number(e.episode)}`);
      }
    }
  }

  // Cap how many new jobs one scan may insert — most popular first
  const maxScan = Math.max(1, s.maxScanJobs || 10);
  let scanInserted = 0;
  const sorted = [...candidates].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  for (const c of sorted) {
    const epExists = c.media_type === "tv" && existingEps.has(`${c.tmdb_id}:${c.season_number}:${c.episode_number}`);
    if (known.has(keyOf(c)) || epExists || (c.media_type === "movie" && doneMovies.has(c.tmdb_id))) { skipped++; continue; }
    if (scanInserted >= maxScan) { skipped++; continue; }
    scanInserted++;
    const status = c.release_date > now ? "upcoming" : "waiting_embed";
    const { error } = await sb.from("subtitle_automation_jobs").insert({ ...c, status });
    if (error) { log(`Insert failed ${c.title}: ${error.message}`); continue; }
    inserted++;
    log(`+ ${c.title} (${status})`);
  }
  log(`Scan done: ${inserted} inserted, ${skipped} skipped`);
  return { inserted, skipped, candidates: candidates.length };
}

/* ---------------- Stage 2: Processor ---------------- */
function fill(tpl: string, j: any) {
  return tpl
    .replaceAll("{tmdb}", String(j.tmdb_id))
    .replaceAll("{type}", j.media_type)
    .replaceAll("{season}", String(j.season_number))
    .replaceAll("{episode}", String(j.episode_number));
}

export function embedUrl(s: Pick<Settings, "embedProbeUrl">, j: any) {
  if (s.embedProbeUrl?.trim()) return fill(s.embedProbeUrl.trim(), j);
  return j.media_type === "movie"
    ? `https://embedmaster.com/json/movie/check/${j.tmdb_id}`
    : `https://embedmaster.com/json/tv/check/${j.tmdb_id}/${j.season_number}/${j.episode_number}`;
}

export function countSources(d: any) {
  const src = d?.item ?? d?.data ?? d ?? {};
  const embed = Number(src.sources_count ?? d?.sources_count ?? 0) || 0;
  const premium = Number(src.premium_sources_count ?? d?.premium_sources_count ?? 0) || 0;
  return { embed, premium, total: embed + premium };
}

export async function probeEmbed(s: Pick<Settings, "embedProbeUrl">, j: any, log: Log = () => {}) {
  try {
    const r = await fetch(embedUrl(s, j), { headers: { Accept: "application/json" } });
    if (!r.ok) { log(`  EmbedMaster HTTP ${r.status}`); return false; }
    const c = countSources(await r.json());
    log(`  found ${c.total} playable source(s) (${c.embed} embed, ${c.premium} premium)`);
    return c.total > 0;
  } catch (e) {
    log(`  EmbedMaster error: ${(e as Error).message}`);
    return false;
  }
}

export function srtFromZip(buf: Uint8Array, j: any): string | null {
  const files = unzipSync(buf);
  const names = Object.keys(files).filter((n) => n.toLowerCase().endsWith(".srt"));
  if (!names.length) return null;
  const pick = j.media_type === "tv" ? names.find((n) => matchesEpisode(n, j)) ?? (names.length === 1 ? names[0] : undefined) : names[0];
  return pick ? strFromU8(files[pick]!) : null;
}

export function matchesEpisode(name: string, j: any) {
  const re = new RegExp(`s0*${j.season_number}\\s*[ex._-]?\\s*e?0*${j.episode_number}(?!\\d)|\\b0*${j.season_number}x0*${j.episode_number}(?!\\d)`, "i");
  return re.test(name);
}

/**
 * Cut check: an English sub made for a different cut (Director's / International) never lines up with the
 * video, so it is rejected before any translation. Measured on real SubDL subs: matching cuts end 0–12 min
 * before the TMDB runtime (end credits); wrong cuts were 29 min short or 36 min long.
 */
export type CutCheck = { runtimeMin: number | null; downloads: number; rejected: string[] };
export const CUT_MAX_DOWNLOADS = 4; // SubDL free keys have a small daily download limit
export const newCutCheck = (runtimeMin: number | null | undefined): CutCheck =>
  ({ runtimeMin: Number(runtimeMin) > 0 ? Number(runtimeMin) : null, downloads: 0, rejected: [] });

/** Minute the last real (non-ad) cue ends. */
export function lastCueEndMin(srt: string): number {
  let end = 0;
  for (const c of parseSrt(cleanSrt(srt).srt)) {
    const m = c.time.split("-->")[1]?.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (m) end = Math.max(end, ((+m[1]! * 60 + +m[2]!) * 60 + +m[3]!) * 1000 + +m[4]!.padEnd(3, "0").slice(0, 3));
  }
  return end / 60000;
}

/** Returns why the sub does not fit the video length, or null when it fits. */
export function cutMismatch(subEndMin: number, runtimeMin: number): string | null {
  const sub = Math.round(subEndMin);
  if (subEndMin > runtimeMin + 5) return `English sub runs ${sub} min but the video is ${runtimeMin} min (longer cut)`;
  if (runtimeMin - subEndMin > Math.max(15, runtimeMin * 0.1)) return `English sub ends at ${sub} min but the video is ${runtimeMin} min (shorter cut)`;
  return null;
}

const EXTRAS_RE = /making[\s._-]?of|behind[\s._-]the[\s._-]scenes|featurette|commentary|trailer|bonus|extras/i;
/** Reject from the release name alone (no download): extras, or a stated length like "(191 min)" far from the runtime. */
export function cutMismatchFromName(name: string, title: string, runtimeMin: number): string | null {
  if (EXTRAS_RE.test(name) && !EXTRAS_RE.test(title)) return `"${name.slice(0, 60)}" is an extra, not the main video`;
  const m = name.match(/\b(\d{2,3})\s?min/i);
  if (m && Math.abs(Number(m[1]) - runtimeMin) > 10) return `"${name.slice(0, 60)}" is a ${m[1]} min cut, video is ${runtimeMin} min`;
  return null;
}

/** True when the downloaded sub fits; logs and records the reason when it does not. */
function cutFits(txt: string, label: string, check: CutCheck | undefined, log: Log): boolean {
  if (!check?.runtimeMin) return true;
  const why = cutMismatch(lastCueEndMin(txt), check.runtimeMin);
  if (!why) { log(`  length check OK: sub ends at ${Math.round(lastCueEndMin(txt))} min, video ${check.runtimeMin} min`); return true; }
  check.rejected.push(why);
  log(`  ✗ skipped ${label}: ${why}`);
  return false;
}

async function fetchSubdl(j: any, key: string, log: Log, check?: CutCheck): Promise<string | null> {
  const byId = await fetchSubdlBy(j, key, log, { tmdb_id: String(j.tmdb_id) }, check);
  if (byId) return byId;
  if (check?.rejected.length) return null; // the title was found, only wrong cuts — a name search finds the same subs
  const name = String(j.title ?? "").replace(/\s+S\d+E\d+$/, "").trim();
  if (!name) return null;
  log(`  SubDL: nothing by TMDB ID, searching by name "${name}"…`);
  return fetchSubdlBy(j, key, log, { film_name: name }, check);
}

async function fetchSubdlBy(j: any, key: string, log: Log, q: Record<string, string>, check?: CutCheck): Promise<string | null> {
  const u = new URL("https://api.subdl.com/api/v1/subtitles");
  u.searchParams.set("api_key", key);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  u.searchParams.set("type", j.media_type);
  u.searchParams.set("languages", "EN");
  u.searchParams.set("unpack", "1");
  if (j.media_type === "tv") {
    u.searchParams.set("season_number", String(j.season_number));
    u.searchParams.set("episode_number", String(j.episode_number));
  }
  const r = await fetch(u);
  if (!r.ok) throw new Error(`SubDL ${r.status}`);
  const d: any = await r.json();
  if (d?.status === false || !Array.isArray(d?.subtitles)) {
    log(`  SubDL: ${d?.error ?? d?.message ?? "no results"}`);
    return null;
  }
  log(`  SubDL: ${d.subtitles.length} English result(s)`);
  // Prioritize WEB-DL / WEBRip releases matching embed video streams to prevent release-offset delays
  const scoredSubtitles = [...d.subtitles].sort((a: any, b: any) => {
    const score = (sub: any) => {
      let s = 0;
      const name = `${sub.release_name ?? ""} ${sub.name ?? ""} ${(sub.unpack_files ?? []).map((f: any) => f.name ?? "").join(" ")}`.toLowerCase();
      if (/web-?dl|web-?rip|\bweb\b/i.test(name)) s += 50;
      if (/\b(?:nf|netflix|amzn|amazon|dsnp|disney|hbo|max|apple|atvp)\b/i.test(name)) s += 30;
      if (/1080p|720p|2160p|4k/i.test(name)) s += 10;
      if (/bluray|bdrip|brrip/i.test(name)) s += 5;
      if (/\b(?:cam|hdcam|telesync|ts|hdts|tc|screener|scr|dvdscr)\b/i.test(name)) s -= 100;
      if (sub.hi) s -= 5;
      return s;
    };
    return score(b) - score(a);
  });
  const dl = async (path: string) => {
    const url = `https://dl.subdl.com${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { "x-api-key": key } });
    if (res.status === 429) throw new SubdlLimitError();
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf[0] === 0x50 && buf[1] === 0x4b) return srtFromZip(buf, j);
    return new TextDecoder().decode(buf);
  };
  for (const sub of scoredSubtitles) {
    const label = String(sub.release_name ?? sub.name ?? "subtitle");
    if (check?.runtimeMin) {
      const why = cutMismatchFromName(label, String(j.title ?? ""), check.runtimeMin);
      if (why) { check.rejected.push(why); log(`  ✗ skipped ${why}`); continue; }
      if (check.downloads >= CUT_MAX_DOWNLOADS) { log(`  stopped after ${CUT_MAX_DOWNLOADS} downloads (SubDL daily limit is small)`); return null; }
    }
    const files: any[] = (sub.unpack_files ?? []).filter((f: any) => String(f.name ?? f.url ?? "").toLowerCase().endsWith(".srt"));
    const file = j.media_type === "tv" ? files.find((f) => matchesEpisode(f.name ?? f.url, j)) ?? (files.length === 1 ? files[0] : null) : files[0];
    try {
      const path = file?.url ?? sub.url;
      if (!path) continue;
      if (check) check.downloads++;
      const txt = await dl(path);
      if (txt && txt.includes("-->") && cutFits(txt, `"${label.slice(0, 60)}"`, check, log)) return txt;
    } catch (e) {
      if (e instanceof SubdlLimitError) throw e;
      log(`  SubDL download error: ${(e as Error).message}`);
    }
  }
  return null;
}

class SubdlLimitError extends Error { constructor() { super("SubDL daily limit reached"); } }

/** All SubDL keys: settings, SUBDL_API_KEY (comma-separated ok), SUBDL_API_KEY_1.._N (any suffix). */
export function subdlKeys(s?: Partial<Settings>, env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  const add = (v?: string) => { for (const k of String(v ?? "").split(/[,\s]+/)) if (k && !out.includes(k)) out.push(k); };
  add(s?.subdlApiKey);
  add(env["SUBDL_API_KEY"]);
  const numbered = Object.keys(env)
    .filter((n) => /^SUBDL_API_KEY_?\d+$/.test(n))
    .sort((a, b) => Number(a.match(/\d+$/)![0]) - Number(b.match(/\d+$/)![0]));
  for (const n of numbered) add(env[n]);
  return out;
}

export async function fetchEnglishSrt(j: any, s?: Partial<Settings>, log: Log = () => {}, check?: CutCheck): Promise<string | null> {
  const keys = subdlKeys(s);
  if (keys.length) {
    for (let i = 0; i < keys.length; i++) {
      try {
        const t = await fetchSubdl(j, keys[i]!, log, check);
        if (t) { log(`  found English SRT on SubDL${keys.length > 1 ? ` (key ${i + 1})` : ""}`); return t; }
        break; // key works, just no sub
      } catch (e) {
        if (e instanceof SubdlLimitError || /SubDL 429/.test((e as Error).message)) {
          log(`  SubDL key ${i + 1} daily limit reached${i + 1 < keys.length ? `, switching to key ${i + 2}…` : " — no more keys"}`);
          continue;
        }
        log(`  SubDL error: ${(e as Error).message}`);
        break;
      }
    }
    log(`  SubDL found no usable English sub, falling back to Wyzie…`);
  } else {
    log(`  SubDL skipped — no SubDL API key set, falling back to Wyzie…`);
  }
  return fetchWyzie(j, s, log, check);
}

async function fetchWyzie(j: any, s?: Partial<Settings>, log: Log = () => {}, check?: CutCheck): Promise<string | null> {
  const u = new URL("https://sub.wyzie.io/search");
  const wk = s?.wyzieApiKey?.trim() || process.env["WYZIE_API_KEY"];
  if (wk) u.searchParams.set("key", wk);
  u.searchParams.set("id", String(j.tmdb_id));
  u.searchParams.set("language", "en");
  u.searchParams.set("format", "srt");
  if (j.media_type === "tv") {
    u.searchParams.set("season", String(j.season_number));
    u.searchParams.set("episode", String(j.episode_number));
  }
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok) return null;
  const list = await r.json();
  const items: any[] = Array.isArray(list) ? list.filter((x: any) => x.url) : [];
  for (const item of items.slice(0, check?.runtimeMin ? 3 : 1)) {
    const srt = await fetch(item.url);
    if (!srt.ok) continue;
    const txt = await srt.text();
    if (txt.includes("-->") && cutFits(txt, `Wyzie "${String(item.release ?? item.media ?? "subtitle").slice(0, 60)}"`, check, log)) return txt;
  }
  return null;
}

const PROMO_DOMAINS = /(opensubtitles|addic7ed|subscene|subdl|yts|yify|podnapisi|tvsubtitles|subsmax|osdb|rarbg|eztv)/i;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|mx|to|tv|io|me|info|co|lk|xyz|cc|ws|ru)\b(?:\/\S*)?/gi;
const PROMO_PHRASES = /(subtitles?\s+(by|ripped|downloaded|provided)|downloaded\s+from|sync(ed|hroni[sz]ed)?\s+(and\s+corrected\s+)?by|correct(ed|ions)\s+by|ripped\s+by|encoded\s+by|translated\s+by|advertise\s+your\s+product|support\s+us\s+and\s+become\s+vip|contact\s+www|api\.opensubtitles|please\s+rate\s+this\s+subtitle|resync|sub(title)?s?\s+edited\s+by)/i;

const PROMO_TAIL = new RegExp(PROMO_PHRASES.source + ".*$", "i");

/** Remove watermark/promo text from an SRT, drop promo-only cues and re-index from 1. */
export function cleanSrt(input: string): { srt: string; removed: number } {
  const blocks = input.replace(/^\uFEFF/, "").replace(/\r/g, "").trim().split(/\n\s*\n/);
  const kept: { time: string; text: string[] }[] = [];
  let removed = 0;
  for (const b of blocks) {
    const lines = b.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti === -1) { removed++; continue; }
    const text = lines
      .slice(ti + 1)
      .map((l) => l.replace(PROMO_TAIL, ""))
      .map((l) => l.replace(URL_RE, "").replace(PROMO_DOMAINS, (m) => (/[a-z]/.test(m) && l.includes(".") ? "" : m)))
      .map((l) => l.replace(/<\/?font[^>]*>/gi, "").replace(/\s{2,}/g, " ").trim())
      .filter((l) => l.replace(/<[^>]+>|[\s\-–—:|.,!?()\[\]{}"'*#~]/g, "").length > 0);
    if (!text.length) { removed++; continue; }
    kept.push({ time: lines[ti]!.trim(), text });
  }
  const srt = kept.map((c, i) => `${i + 1}\n${c.time}\n${c.text.join("\n")}`).join("\n\n");
  return { srt: srt ? srt + "\n" : "", removed };
}

export const ONFLIX_WATERMARK = "OnFlix.lk වෙතින් සිංහල උපසිරැසි";
const toMs = (t: string) => { const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/); return m ? ((+m[1]! * 60 + +m[2]!) * 60 + +m[3]!) * 1000 + +m[4]! : 0; };
const fmtMs = (ms: number) => { const p = (n: number, l = 2) => String(Math.floor(n)).padStart(l, "0"); return `${p(ms / 3600000)}:${p((ms / 60000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`; };

/** Add an OnFlix credit cue at the start (if there's a gap) and after the last cue; re-index. */
export function addWatermark(input: string, text = ONFLIX_WATERMARK): string {
  const cues = input.replace(/^\uFEFF/, "").replace(/\r/g, "").trim().split(/\n\s*\n/).map((b) => {
    const l = b.split("\n"); const ti = l.findIndex((x) => x.includes("-->"));
    if (ti === -1) return null;
    const rest = l.slice(ti + 1).map((x) => x.split(text).join("").trim()).filter(Boolean);
    return rest.length ? { time: l[ti]!.trim(), text: rest.join("\n") } : null;
  }).filter((c): c is { time: string; text: string } => !!c);
  if (!cues.length) return input;
  const firstStart = toMs(cues[0]!.time.split("-->")[0]!);
  const lastEnd = toMs(cues[cues.length - 1]!.time.split("-->")[1]!);
  if (firstStart >= 1500) {
    const end = Math.min(firstStart - 200, 5000);
    cues.unshift({ time: `${fmtMs(500)} --> ${fmtMs(end)}`, text });
  }
  cues.push({ time: `${fmtMs(lastEnd + 1000)} --> ${fmtMs(lastEnd + 5000)}`, text });
  return cues.map((c, i) => `${i + 1}\n${c.time}\n${c.text}`).join("\n\n") + "\n";
}

export type WatermarkIssue = { cue: number; time: string; kind: "overlap" | "duplicate"; text: string };

/** Find OnFlix watermark cues that clash with dialogue (time or same cue) or appear more than once at start/end. */
export function checkWatermark(input: string, text = ONFLIX_WATERMARK): WatermarkIssue[] {
  const cues = input.replace(/^\uFEFF/, "").replace(/\r/g, "").trim().split(/\n\s*\n/).flatMap((b) => {
    const l = b.split("\n"); const ti = l.findIndex((x) => x.includes("-->"));
    if (ti === -1) return [];
    const [a, z] = l[ti]!.split("-->");
    const lines = l.slice(ti + 1);
    return [{ time: l[ti]!.trim(), s: toMs(a!), e: toMs(z!), lines, wm: lines.some((x) => x.includes(text)) }];
  });
  const issues: WatermarkIssue[] = [];
  const wmIdx = cues.map((c, i) => (c.wm ? i : -1)).filter((i) => i >= 0);
  const firstDlg = cues.findIndex((c) => !c.wm);
  for (const i of wmIdx) {
    const c = cues[i]!; const txt = c.lines.join(" / ");
    const mixed = c.lines.some((x) => x.trim() && !x.includes(text)) || c.lines.some((x) => x.replace(text, "").trim());
    const clash = cues.some((d, j) => j !== i && !d.wm && d.s < c.e && c.s < d.e);
    if (mixed || clash) issues.push({ cue: i + 1, time: c.time, kind: "overlap", text: txt });
    const atStart = firstDlg === -1 || i < firstDlg;
    const sameSide = wmIdx.filter((k) => (firstDlg === -1 || k < firstDlg) === atStart);
    if (sameSide.length > 1 && sameSide[0] !== i) issues.push({ cue: i + 1, time: c.time, kind: "duplicate", text: txt });
  }
  return issues;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function decodeEntities(t: string) {
  return t
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

export type Cue = { index: string; time: string; text: string };

export function parseSrt(srt: string): Cue[] {
  return srt.replace(/^\uFEFF/, "").replace(/\r/g, "").trim().split(/\n\s*\n/).flatMap((b) => {
    const lines = b.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti === -1) return [];
    const time = lines[ti];
    if (!time) return [];
    return [{ index: (lines[ti - 1] ?? "").trim(), time: time.trim(), text: lines.slice(ti + 1).join("\n") }];
  });
}

/** Removes Telugu/Tamil/Kannada/Hindi/etc. letters that leaked into a Sinhala SRT; indices and timestamps are ASCII and untouched. */
export function sanitizeSinhalaSrt(srt: string): string {
  return hasForeignScript(srt) ? fixForeignScript(srt) : srt;
}

export function buildSrt(cues: Cue[]) {
  return cues.map((c, i) => `${c.index || i + 1}\n${c.time}\n${c.text}`).join("\n\n") + "\n";
}

export function myMemoryEmail(s?: Partial<Settings>) {
  return s?.myMemoryEmail?.trim() || process.env["MYMEMORY_USER_EMAIL"] || "cinemaestlk@gmail.com";
}

async function myMemory(text: string, email: string): Promise<string> {
  const u = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|si&de=${encodeURIComponent(email)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(u);
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`MyMemory ${r.status}`);
    const d: any = await r.json();
    const out = d?.responseData?.translatedText;
    if (Number(d?.responseStatus) !== 200 || typeof out !== "string" || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out))
      throw new Error(`MyMemory: ${d?.responseDetails || out || "bad response"}`);
    return decodeEntities(out);
  }
  throw new Error("MyMemory rate limited");
}

/** Translate one cue text (<=500 chars per query; longer text split by line). */
async function translateCueText(text: string, email: string): Promise<string> {
  const t = text.trim();
  if (!t) return text;
  if (t.length <= 500) return myMemory(t, email);
  const parts: string[] = [];
  for (const line of t.split("\n")) parts.push(line.length <= 500 ? await myMemory(line, email) : await myMemory(line.slice(0, 500), email));
  return parts.join("\n");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const GTX_REQUEST_TIMEOUT_MS = 15_000;
const GTX_TIMEOUT_RETRIES = 3;
const GTX_RETRY_DELAY_MS = 1_000;

class GtxRequestError extends Error {
  constructor(message: string, readonly timedOut = false) {
    super(message);
    this.name = "GtxRequestError";
  }
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError";
}

export async function gtx(
  text: string,
  options: {
    timeoutMs?: number;
    retryDelayMs?: number;
    onRetry?: (message: string) => void;
  } = {},
): Promise<string> {
  const { timeoutMs = GTX_REQUEST_TIMEOUT_MS, retryDelayMs = GTX_RETRY_DELAY_MS, onRetry } = options;
  const t = text.trim();
  if (!t) return text;
  let timeoutRetries = 0;
  const retryTimeout = async () => {
    if (timeoutRetries >= GTX_TIMEOUT_RETRIES) {
      throw new GtxRequestError(`Google GTX timed out after ${timeoutMs}ms and ${GTX_TIMEOUT_RETRIES} retries`, true);
    }
    timeoutRetries++;
    const delay = retryDelayMs * 2 ** (timeoutRetries - 1);
    onRetry?.(`Google GTX timed out after ${timeoutMs}ms; retry ${timeoutRetries}/${GTX_TIMEOUT_RETRIES} in ${delay / 1000}s`);
    await sleep(delay);
  };
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=si&dt=t&q=${encodeURIComponent(t)}`,
        { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs) },
      );
    } catch (e) {
      if (isTimeoutError(e)) {
        await retryTimeout();
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      throw new GtxRequestError(`Google GTX request failed: ${message}`);
    }
    if (r.status === 429 && attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!r.ok) throw new GtxRequestError(`Google GTX ${r.status}`);
    let d: any;
    try {
      d = await r.json();
    } catch (e) {
      if (isTimeoutError(e)) {
        await retryTimeout();
        continue;
      }
      throw new GtxRequestError(`Google GTX response failed: ${(e as Error).message}`);
    }
    if (!Array.isArray(d?.[0])) throw new GtxRequestError("Google GTX: unexpected response");
    return d[0].map((p: any) => p?.[0] ?? "").join("");
  }
}

async function mapCues(cues: Cue[], fn: (t: string) => Promise<string>, concurrency: number, pause: number, log?: Log) {
  const out: Cue[] = new Array(cues.length);
  let next = 0, done = 0;
  const step = Math.max(1, Math.floor(cues.length / 100));
  const worker = async () => {
    while (next < cues.length) {
      const i = next++;
      const c = cues[i]!;
      out[i] = { ...c, text: await fn(c.text) };
      done++; if (log && (done % step === 0 || done === cues.length)) log(`@@pct:${done}/${cues.length}`);
      await sleep(pause);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

const NL = " ¶ ";

/** Translate cues in batches of line-separated text; falls back per-cue if a batch's lines don't line up or it fails. */
export async function gtxBatch(cues: Cue[], log: Log, tr: (t: string) => Promise<string> = gtx, maxCues = 25, maxChars = 1800) {
  const translate = tr === gtx
    ? (text: string) => gtx(text, { onRetry: (message) => log(`  ${message}`) })
    : tr;
  const batches: number[][] = [];
  let cur: number[] = [], len = 0;
  cues.forEach((c, i) => {
    const l = c.text.replace(/\n/g, NL).length + 1;
    if (cur.length && (cur.length >= maxCues || len + l > maxChars)) { batches.push(cur); cur = []; len = 0; }
    cur.push(i); len += l;
  });
  if (cur.length) batches.push(cur);
  const out: Cue[] = cues.map((c) => ({ ...c }));
  let fallbacks = 0, perCueFail = 0;
  const doBatch = async (idx: number[]) => {
    const src = idx.map((i) => cues[i]!.text.replace(/\n/g, NL).trim());
    try {
      const res = (await translate(src.join("\n"))).split("\n");
      if (res.length !== idx.length) throw new Error(`line mismatch ${res.length}/${idx.length}`);
      idx.forEach((i, k) => { out[i]!.text = res[k]!.replace(/\s*¶\s*/g, "\n").trim(); });
    } catch (e) {
      fallbacks++;
      if (e instanceof GtxRequestError) {
        if (e.timedOut) throw e;
        perCueFail += idx.length;
        doneCues += idx.length;
        log(`  Google Translate batch failed (${e.message}); skipping per-cue retries`);
        return;
      }
      for (const i of idx) {
        try { out[i]!.text = (await translate(cues[i]!.text)).trim(); }
        catch { perCueFail++; }
        await sleep(50);
      }
    }
  };
  let next = 0, doneCues = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < batches.length) {
      const b = batches[next++]!; await doBatch(b); doneCues += b.length;
      log(`@@pct:${doneCues}/${cues.length}`); await sleep(50);
    }
  }));
  log(`  Google Translate: ${batches.length} batch request(s), ${fallbacks} per-cue fallback(s)`);
  if (perCueFail > cues.length * 0.2) throw new Error(`${perCueFail} cues failed`);
  return out;
}

export async function translateSrt(srt: string, log: Log, s?: Partial<Settings>) {
  return sanitizeSinhalaSrt(await translateSrtRaw(srt, log, s));
}

async function translateSrtRaw(srt: string, log: Log, s?: Partial<Settings>) {
  const cues = parseSrt(srt);
  const keys = geminiKeys();
  if (keys.length > 0) {
    try {
      const out = await polishCues(cues, [], log, { fallbackTranslate: (t) => gtx(t) });
      return buildSrt(out);
    } catch (e) {
      if (e instanceof GtxRequestError && e.timedOut) throw e;
      log(`  Gemini direct translation failed (${(e as Error).message}), falling back to Google Translate…`);
    }
  }
  try {
    const out = await gtxBatch(cues, log);
    log(`  translated ${cues.length} cues via Google Translate`);
    return buildSrt(out);
  } catch (e) {
    if (e instanceof GtxRequestError && e.timedOut) throw e;
    log(`  Google Translate failed (${(e as Error).message}), falling back to MyMemory`);
  }
  const email = myMemoryEmail(s);
  const out = await mapCues(cues, (t) => translateCueText(t, email), 4, 100, log);
  log(`  translated ${cues.length} cues via MyMemory`);
  return buildSrt(out);
}

async function hmacHex(secret: string, body: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const slugify = (t: string, id: number) =>
  `${t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${id}`;

const AUTO = (now: string) => ({
  subtitle_automation_status: "completed",
  subtitle_automation_last_attempt_at: now,
  subtitle_automation_error: null,
  subtitle_automation_source: "onflix_automation",
});

async function ensureContent(sb: SupabaseClient, s: Settings, j: any) {
  const { data: c } = await sb.from("content").select("id,slug,seasons,source").eq("tmdb_id", j.tmdb_id).limit(1).maybeSingle();

  // Fetch fresh TMDB data regardless of whether content exists (append videos, external_ids, images)
  const d = await tmdb(`/${j.media_type}/${j.tmdb_id}`, { append_to_response: "videos,external_ids,images" });
  const vids: any[] = d.videos?.results ?? [];
  const trailerKey = (vids.find((v) => v.site === "YouTube" && v.type === "Trailer") ?? vids.find((v) => v.site === "YouTube"))?.key;
  if (!d.imdb_id && d.external_ids?.imdb_id) d.imdb_id = d.external_ids.imdb_id;
  const title = d.title ?? d.name ?? j.title.replace(/ S\d+E\d+$/, "");
  const date = d.release_date ?? d.first_air_date ?? "";
  const year = date ? Number(date.slice(0, 4)) : null;
  const img = (p?: string | null, size = "w500") => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);

  const logos: any[] = d.images?.logos ?? [];
  const logo = logos.find((l: any) => l.iso_639_1 === "en") ?? logos[0];

  // Fields safe to refresh from TMDB (never overwrite user-managed fields like video_link, mp4_link, etc.)
  const tmdbMeta = {
    overview: d.overview ?? null,
    poster_url: img(d.poster_path, "w500"),
    backdrop_url: img(d.backdrop_path, "w1280"),
    thumbnail_url: img(d.backdrop_path, "w780"),
    logo_url: img(logo?.file_path),
    language: d.original_language ?? null,
    release_year: year,
    year,
    runtime: d.runtime ?? null,
    rating: d.vote_average ?? null,
    vote_count: d.vote_count ?? null,
    imdb_id: d.imdb_id ?? null,
    tagline: d.tagline ?? null,
    youtube_trailer_key: trailerKey ?? null,
    trailer_url: trailerKey ? `https://www.youtube.com/watch?v=${trailerKey}` : null,
    is_adult: !!d.adult,
    updated_at: new Date().toISOString(),
  };

  let contentId = c?.id;
  let finalSlug = c?.slug || slugify(title, j.tmdb_id);

  if (c) {
    // Content already exists — refresh TMDB metadata but preserve user-managed fields
    await sb.from("content").update(tmdbMeta).eq("id", c.id);
  } else {
    // New content — full insert
    const ins = await sb
      .from("content")
      .insert({
        type: j.media_type === "movie" ? "movie" : s.seriesTypeValue,
        title,
        slug: finalSlug,
        tmdb_id: j.tmdb_id,
        ...tmdbMeta,
        embed_link: j.media_type === "movie" ? buildEmbedLink(j) : null,
        status: "published",
        published_at: new Date().toISOString(),
        source: "subtitle_automation",
      })
      .select("id,slug,seasons")
      .single();
    if (ins.error) throw new Error(`content insert: ${ins.error.message}`);
    contentId = ins.data.id;
    finalSlug = ins.data.slug;
  }

  // Sync genres with content_rels if available from TMDB
  if (contentId && Array.isArray(d.genres) && d.genres.length > 0) {
    try {
      const gNames = d.genres.map((g: any) => String(g.name ?? "").trim().toLowerCase()).filter(Boolean);
      const { data: matchedGenres } = await sb.from("genres").select("id,name,slug");
      if (matchedGenres && matchedGenres.length > 0) {
        const targetIds = matchedGenres
          .filter((mg) => gNames.includes(String(mg.name ?? "").trim().toLowerCase()) || gNames.includes(String(mg.slug ?? "").trim().toLowerCase()))
          .map((mg) => mg.id);
        if (targetIds.length > 0) {
          await sb.from("content_rels").delete().eq("parent_id", contentId).eq("path", "genres");
          await sb.from("content_rels").insert(
            targetIds.map((gid, idx) => ({
              parent_id: contentId,
              path: "genres",
              genres_id: gid,
              order: idx + 1,
            }))
          );
        }
      }
    } catch {
      // Non-fatal: genre rel sync should never break subtitle pipeline
    }
  }

  return { id: contentId, slug: finalSlug, seasons: c?.seasons ?? null };
}

export type MergeSeasonEpisode = {
  episode_number: number;
  title?: string | null;
  embed_link?: string | null;
  sinhala_subtitle_url?: string | null;
  season_poster_url?: string | null;
  season_year?: number | null;
  status?: string | null;
  is_public?: boolean | null;
  air_date?: string | null;
  overview?: string | null;
  runtime?: number | null;
  video_link?: string | null;
  mp4_link?: string | null;
  dailymotion_link?: string | null;
  subtitle_credit_url?: string | null;
  telegram_file_id?: string | null;
};

export function mergeSeason(existing: unknown, num: number, episode?: MergeSeasonEpisode) {
  const list: any[] = Array.isArray(existing) ? JSON.parse(JSON.stringify(existing)) : [];
  let s = list.find((x) => Number(x?.season_number) === num);
  if (!s) {
    s = { season_number: num, season_name: `Season ${num}`, episodes: [] };
    list.push(s);
  }
  if (!Array.isArray(s.episodes)) s.episodes = [];
  if (episode?.season_poster_url && !s.season_poster_url) {
    s.season_poster_url = episode.season_poster_url;
  }
  if (episode?.season_year != null && s.season_year == null) {
    s.season_year = episode.season_year;
  }
  if (episode && episode.episode_number != null) {
    const epNum = Number(episode.episode_number);
    const existingIdx = s.episodes.findIndex((e: any) => Number(e?.episode_number) === epNum);
    const existingEp = existingIdx >= 0 ? s.episodes[existingIdx] : {};
    const epData = {
      air_date: episode.air_date ?? existingEp.air_date ?? "",
      dailymotion_link: episode.dailymotion_link ?? existingEp.dailymotion_link ?? "",
      embed_link: episode.embed_link ?? existingEp.embed_link ?? "",
      episode_number: epNum,
      is_public: episode.is_public !== undefined && episode.is_public !== null ? Boolean(episode.is_public) : (existingEp.is_public !== false),
      mp4_link: episode.mp4_link ?? existingEp.mp4_link ?? "",
      overview: episode.overview ?? existingEp.overview ?? "",
      runtime: episode.runtime ?? existingEp.runtime ?? null,
      sinhala_subtitle_url: episode.sinhala_subtitle_url ?? existingEp.sinhala_subtitle_url ?? "",
      status: episode.status ?? existingEp.status ?? "published",
      subtitle_credit_url: episode.subtitle_credit_url ?? existingEp.subtitle_credit_url ?? "",
      telegram_file_id: episode.telegram_file_id ?? existingEp.telegram_file_id ?? "",
      title: episode.title || existingEp.title || `Episode ${epNum}`,
      video_link: episode.video_link ?? existingEp.video_link ?? "",
    };
    if (existingIdx >= 0) {
      s.episodes[existingIdx] = { ...existingEp, ...epData };
    } else {
      s.episodes.push(epData);
    }
    s.episodes.sort((a: any, b: any) => Number(a?.episode_number) - Number(b?.episode_number));
  }
  return list.sort((a, b) => Number(a?.season_number) - Number(b?.season_number));
}

export function buildEmbedLink(j: { media_type: string; tmdb_id: number | string; season_number?: number; episode_number?: number }) {
  return j.media_type === "movie"
    ? `https://embedmaster.link/movie/${j.tmdb_id}`
    : `https://embedmaster.link/tv/${j.tmdb_id}/${j.season_number}/${j.episode_number}`;
}

async function episodeDetails(j: any) {
  try {
    const [ep, se] = await Promise.all([
      tmdb(`/tv/${j.tmdb_id}/season/${j.season_number}/episode/${j.episode_number}`).catch(() => null),
      tmdb(`/tv/${j.tmdb_id}/season/${j.season_number}`).catch(() => null),
    ]);
    const year = (se?.air_date ?? ep?.air_date ?? "").slice(0, 4);
    return {
      title: ep?.name ?? null,
      season_poster_url: se?.poster_path ? `https://image.tmdb.org/t/p/w500${se.poster_path}` : null,
      season_year: year ? Number(year) : null,
      season_episodes: Array.isArray(se?.episodes) ? se.episodes : [],
    };
  } catch {
    return { title: null, season_poster_url: null, season_year: null, season_episodes: [] };
  }
}

/** Rank OnFlix content by TMDB weekly trending order (pure, testable). */
export function rankTrending(trendingIds: number[], rows: { id: number; tmdb_id: number | string }[], limit = 10) {
  const byTmdb = new Map(rows.map((r) => [Number(r.tmdb_id), r.id]));
  return trendingIds.map((t) => byTmdb.get(t)).filter((x): x is number => x != null).slice(0, limit);
}

/** Sync featured + Top 10 (top_ten_rels) from TMDB weekly trending. Never throws. */
export async function syncTrending(sb: SupabaseClient, log: Log = () => {}) {
  try {
    const [mv, tv] = await Promise.all([tmdb("/trending/movie/week"), tmdb("/trending/tv/week")]);
    const mIds: number[] = (mv.results ?? []).map((x: any) => x.id);
    const tIds: number[] = (tv.results ?? []).map((x: any) => x.id);
    const all = [...mIds, ...tIds];
    const { data: rows } = await sb.from("content").select("id,tmdb_id,type").in("tmdb_id", all);
    const list = rows ?? [];
    const movies = rankTrending(mIds, list.filter((r: any) => r.type === "movie"));
    const shows = rankTrending(tIds, list.filter((r: any) => r.type !== "movie"));
    const trendingContent = list.map((r: any) => r.id);
    const now = new Date().toISOString();
    if (trendingContent.length) await sb.from("content").update({ featured: true }).in("id", trendingContent);
    // Un-feature automation titles that dropped off trending (admin-picked ones are left alone)
    let q = sb.from("content").update({ featured: false }).eq("featured", true).eq("source", "subtitle_automation");
    if (trendingContent.length) q = q.not("id", "in", `(${trendingContent.join(",")})`);
    await q;

    const { data: parent } = await sb.from("top_ten").select("id").order("id").limit(1).maybeSingle();
    let pid = parent?.id;
    if (!pid) {
      const ins = await sb.from("top_ten").insert({ created_at: now, updated_at: now }).select("id").single();
      pid = ins.data?.id;
    }
    if (!pid) return;
    for (const [path, ids] of [["top_10_movies", movies], ["top_10_tv_shows", shows]] as const) {
      if (!ids.length) continue; // keep existing list when nothing trending is on OnFlix
      await sb.from("top_ten_rels").delete().eq("parent_id", pid).eq("path", path);
      await sb.from("top_ten_rels").insert(ids.map((content_id, i) => ({ parent_id: pid, path, content_id, order: i + 1 })));
    }
    await sb.from("top_ten").update({ updated_at: now }).eq("id", pid);
    log(`  trending sync: ${trendingContent.length} featured, top10 movies ${movies.length}, tv ${shows.length}`);
  } catch (e: any) {
    log(`  trending sync skipped: ${e?.message ?? e}`);
  }
}

async function upsertOnflix(sb: SupabaseClient, s: Settings, j: any, url: string) {
  const now = new Date().toISOString();
  // ensureContent already refreshes all TMDB metadata (including is_adult) for existing rows
  const c = await ensureContent(sb, s, j);
  const embed_link = buildEmbedLink(j);
  if (j.media_type === "movie") {
    const { error } = await sb.from("content").update({ sinhala_subtitle_url: url, embed_link, ...AUTO(now), updated_at: now }).eq("id", c.id);
    if (error) throw new Error(`content update: ${error.message}`);
    return c;
  }
  // Update every existing row for this content_id + season + episode; insert only when none exist
  const det = await episodeDetails(j);
  const epRowMeta = {
    title: det.title,
    season_poster_url: det.season_poster_url,
    season_year: det.season_year,
  };
  const meta = Object.fromEntries(Object.entries(epRowMeta).filter(([, v]) => v != null));
  const row = { sinhala_subtitle_url: url, embed_link, ...meta, ...AUTO(now), updated_at: now };
  const upd = await sb
    .from("episodes")
    .update(row)
    .eq("content_id", c.id)
    .eq("season", j.season_number)
    .eq("episode", j.episode_number)
    .select("id");
  if (upd.error) throw new Error(`episodes update: ${upd.error.message}`);
  if (!upd.data?.length) {
    const ins = await sb
      .from("episodes")
      .insert({ content_id: c.id, season: j.season_number, episode: j.episode_number, ...row });
    if (ins.error) throw new Error(`episodes insert: ${ins.error.message}`);
  }

  // 1. If TMDB provided full season episodes list, seed all episodes into content.seasons
  let seasons = Array.isArray(c.seasons) ? JSON.parse(JSON.stringify(c.seasons)) : [];
  if (Array.isArray(det.season_episodes) && det.season_episodes.length > 0) {
    for (const tmdbEp of det.season_episodes) {
      seasons = mergeSeason(seasons, j.season_number, {
        episode_number: Number(tmdbEp.episode_number),
        title: tmdbEp.name || `Episode ${tmdbEp.episode_number}`,
        air_date: tmdbEp.air_date ?? "",
        overview: tmdbEp.overview ?? "",
        runtime: tmdbEp.runtime ?? null,
        season_poster_url: det.season_poster_url,
        season_year: det.season_year,
      });
    }
  }

  // 2. Fetch all existing rows from episodes table so content.seasons has the authoritative subbed list
  const { data: dbEpisodes } = await sb
    .from("episodes")
    .select("season,episode,title,embed_link,sinhala_subtitle_url,season_poster_url,season_year,status,is_public,video_link,mp4_link,dailymotion_link,subtitle_credit_url,telegram_file_id")
    .eq("content_id", c.id)
    .order("season", { ascending: true })
    .order("episode", { ascending: true });
  if (dbEpisodes && dbEpisodes.length > 0) {
    for (const ep of dbEpisodes) {
      seasons = mergeSeason(seasons, Number(ep.season), {
        episode_number: Number(ep.episode),
        title: ep.title,
        embed_link: ep.embed_link,
        sinhala_subtitle_url: ep.sinhala_subtitle_url,
        season_poster_url: ep.season_poster_url,
        season_year: ep.season_year ? Number(ep.season_year) : null,
        status: ep.status,
        is_public: ep.is_public,
        video_link: ep.video_link,
        mp4_link: ep.mp4_link,
        dailymotion_link: ep.dailymotion_link,
        subtitle_credit_url: ep.subtitle_credit_url,
        telegram_file_id: ep.telegram_file_id,
      });
    }
  } else {
    seasons = mergeSeason(seasons, j.season_number, {
      episode_number: j.episode_number,
      title: det.title || `Episode ${j.episode_number}`,
      embed_link,
      sinhala_subtitle_url: url,
      season_poster_url: det.season_poster_url,
      season_year: det.season_year,
      status: "published",
      is_public: true,
    });
  }

  await sb.from("content").update({ seasons, episodes_dirty: false, updated_at: now }).eq("id", c.id);
  return c;
}

export async function revalidateOnflixWeb(
  s: Settings,
  c: { id?: number | string; slug?: string | null } | null,
  j: { tmdb_id: number | string; media_type: string },
  log: Log = () => {},
) {
  const url = s.revalidateUrl || process.env["ONFLIX_REVALIDATION_URL"] || "https://onflixlk.vercel.app/api/revalidate";
  const secret = process.env["REVALIDATE_SECRET"] || process.env["ONFLIX_REVALIDATION_SECRET"];
  if (!url || !secret || secret.length < 32) return;

  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const event = {
      eventId: crypto.randomUUID(),
      version: 1,
      entity: j.media_type === "movie" ? "content" : "episodes",
      operation: "update",
      entityId: String(c?.id ?? j.tmdb_id),
      ...(c?.slug ? { slug: c.slug } : {}),
      contentType: j.media_type === "movie" ? "movie" : "tv_show",
      occurredAt: new Date().toISOString(),
    };
    const body = JSON.stringify(event);
    const signature = await hmacHex(secret, `${timestamp}.${body}`);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-onflix-timestamp": timestamp,
        "x-onflix-signature": signature,
      },
      body,
    });
    if (res.ok) {
      log(`  ✓ OnFlix web cache revalidated instantly (${j.media_type}: ${c?.slug || j.tmdb_id})`);
    } else {
      log(`  web cache revalidation returned status ${res.status}`);
    }
  } catch (err: any) {
    log(`  web cache revalidation failed: ${err?.message ?? err}`);
  }
}

type ReviewOpts = {
  manual?: boolean;
  review?: "fix" | "keep" | undefined;
  onIssues?: (i: WatermarkIssue[]) => void;
  cachedTranslatedSrt?: string | undefined;
  cachedPolishedCues?: Record<string | number, string> | undefined;
  onTranslated?: ((srt: string) => void) | undefined;
  onPolishedChunk?: ((cues: [number, string][]) => void) | undefined;
};

async function autoQueueNextEpisode(sb: SupabaseClient, j: any, log: Log = () => {}) {
  if (j.media_type !== "tv" || !j.tmdb_id || j.season_number == null || j.episode_number == null) return;
  const nextEpNum = Number(j.episode_number) + 1;
  const seasonNum = Number(j.season_number);
  const now = today();

  try {
    // 1. Check if next episode in this season exists on TMDB
    let nextEp: any = await tmdb(`/tv/${j.tmdb_id}/season/${seasonNum}/episode/${nextEpNum}`).catch(() => null);
    let targetSeason = seasonNum;
    let targetEp = nextEpNum;

    // If season ended, check season + 1 episode 1
    if (!nextEp) {
      const nextSeasonEp = await tmdb(`/tv/${j.tmdb_id}/season/${seasonNum + 1}/episode/1`).catch(() => null);
      if (nextSeasonEp) {
        nextEp = nextSeasonEp;
        targetSeason = seasonNum + 1;
        targetEp = 1;
      }
    }

    if (!nextEp) return; // No further episodes found on TMDB

    // 2. Check if already queued in subtitle_automation_jobs
    const { data: existingJob } = await sb
      .from("subtitle_automation_jobs")
      .select("id")
      .eq("tmdb_id", j.tmdb_id)
      .eq("media_type", "tv")
      .eq("season_number", targetSeason)
      .eq("episode_number", targetEp)
      .maybeSingle();

    if (existingJob) return; // Already in queue

    // 3. Check if already exists in OnFlix content/episodes
    const { data: content } = await sb.from("content").select("id,title").eq("tmdb_id", j.tmdb_id).maybeSingle();
    if (content?.id) {
      const { data: epRow } = await sb
        .from("episodes")
        .select("id")
        .eq("content_id", content.id)
        .eq("season", targetSeason)
        .eq("episode", targetEp)
        .not("sinhala_subtitle_url", "is", null)
        .maybeSingle();
      if (epRow) return; // Already subbed and published
    }

    const showName = content?.title || j.title.replace(/\s+S\d+E\d+$/, "");
    const epTitle = `${showName} S${targetSeason}E${targetEp}`;
    const releaseDate = nextEp.air_date || null;
    const status = releaseDate && releaseDate > now ? "upcoming" : "waiting_embed";

    const { error: insErr } = await sb.from("subtitle_automation_jobs").insert({
      tmdb_id: j.tmdb_id,
      media_type: "tv",
      title: epTitle,
      season_number: targetSeason,
      episode_number: targetEp,
      release_date: releaseDate,
      popularity: j.popularity ?? null,
      runtime: nextEp.runtime ?? null,
      poster_path: j.poster_path ?? null,
      status,
      attempts: 0,
      next_retry_at: null,
    });

    if (!insErr) {
      log(`  + Auto-queued next episode: ${epTitle} (${status})`);
    }
  } catch (e) {
    log(`  Note: could not auto-queue next episode: ${(e as Error).message}`);
  }
}

/**
 * Pure rule: the previous episode blocks this one when it is queued but not completed
 * and not already published on OnFlix. Episodes never queued (show joined mid-season) don't block.
 */
export function isBlockedByPrevious(prevJobStatus: string | null, prevPublished: boolean) {
  if (prevPublished) return false;
  return prevJobStatus != null && prevJobStatus !== "completed";
}

/** Returns a label like "S1E5" when the previous episode must publish first, else null. */
async function previousEpisodeBlocker(sb: SupabaseClient, j: any): Promise<string | null> {
  if (j.media_type !== "tv" || !(Number(j.episode_number) > 1)) return null;
  const season = Number(j.season_number), prev = Number(j.episode_number) - 1;
  const { data: prevJob } = await sb.from("subtitle_automation_jobs").select("status")
    .eq("tmdb_id", j.tmdb_id).eq("media_type", "tv").eq("season_number", season).eq("episode_number", prev).maybeSingle();
  let published = false;
  const { data: c } = await sb.from("content").select("id").eq("tmdb_id", j.tmdb_id).maybeSingle();
  if (c?.id) {
    const { data: ep } = await sb.from("episodes").select("id").eq("content_id", c.id)
      .eq("season", season).eq("episode", prev).not("sinhala_subtitle_url", "is", null).limit(1);
    published = !!ep?.length;
  }
  return isBlockedByPrevious(prevJob?.status ?? null, published) ? `S${season}E${prev}` : null;
}

export async function claimQueueJob(
  sb: SupabaseClient,
  job: { id: string; status: string; attempts: number },
): Promise<any | null> {
  if (job.status === "processing") return null;
  const claimedAt = new Date().toISOString();
  const { data, error } = await sb.from("subtitle_automation_jobs")
    .update({ status: "processing", attempts: Number(job.attempts ?? 0) + 1, error_log: null, next_retry_at: null, updated_at: claimedAt })
    .eq("id", job.id)
    .eq("status", job.status)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not claim job: ${error.message}`);
  return data;
}

export function prioritizeQueueJobs<T extends { created_at: string; attempts: number; popularity?: number | null }>(jobs: T[]): T[] {
  return [...jobs].sort((left, right) => {
    const leftCreated = Date.parse(left.created_at);
    const rightCreated = Date.parse(right.created_at);
    const createdOrder = (Number.isFinite(leftCreated) ? leftCreated : 0) - (Number.isFinite(rightCreated) ? rightCreated : 0);
    return createdOrder || left.attempts - right.attempts || Number(right.popularity ?? 0) - Number(left.popularity ?? 0);
  });
}

async function processJob(sb: SupabaseClient, s: Settings, j: any, log: Log, opts: ReviewOpts = {}): Promise<string> {
  const claimedJob = await claimQueueJob(sb, j);
  if (!claimedJob) {
    log(`  ⏭ another processor claimed this job; skipping duplicate worker`);
    return "already_processing";
  }
  j = claimedJob;
  const attempts = Number(j.attempts);

  const heartbeat = setInterval(() => {
    void sb.from("subtitle_automation_jobs")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", j.id)
      .eq("status", "processing")
      .then(({ error }) => {
        if (error) log(`  job lock heartbeat failed: ${error.message}`);
      });
  }, 5 * 60 * 1000);
  const retryAt = () => new Date(Date.now() + s.retryHours * 36e5).toISOString();
  // Fast, responsive retry for video stream detection so cron jobs catch videos quickly (15-30 mins instead of 6 hours)
  const embedRetryAt = () => {
    const mins = attempts <= 3 ? 15 : attempts <= 6 ? 30 : Math.min(s.retryHours * 60, 60);
    return new Date(Date.now() + mins * 60 * 1000).toISOString();
  };
  const set = async (patch: any) =>
    sb.from("subtitle_automation_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", j.id);
  const markNeedsReview = async (reason: string, preview: string) => {
    await set({
      status: "failed",
      attempts,
      next_retry_at: null,
      error_log: `[NEEDS_REVIEW] ${reason}`,
      srt_preview: preview.slice(0, 4000),
    });
    log(`  ⚠ Needs Review: ${reason}`);
    return "needs_review";
  };
  try {
    log(`▶ ${j.title}`);

    // Fast-path: Check if this item is already published with a Sinhala subtitle on OnFlix
    if (j.tmdb_id) {
      const { data: contentRow } = await sb
        .from("content")
        .select("id, sinhala_subtitle_url")
        .eq("tmdb_id", j.tmdb_id)
        .maybeSingle();

      if (contentRow?.id) {
        if (j.media_type === "tv" && j.season_number != null && j.episode_number != null) {
          const { data: epRow } = await sb
            .from("episodes")
            .select("id, sinhala_subtitle_url")
            .eq("content_id", contentRow.id)
            .eq("season", j.season_number)
            .eq("episode", j.episode_number)
            .maybeSingle();
          if (epRow?.sinhala_subtitle_url) {
            log(`  ✔ Already published with Sinhala subtitle on OnFlix: ${epRow.sinhala_subtitle_url}`);
            await set({ status: "completed", error_log: null });
            await autoQueueNextEpisode(sb, j, log);
            return "completed";
          }
        } else if (j.media_type === "movie" && contentRow.sinhala_subtitle_url) {
          log(`  ✔ Already published with Sinhala subtitle on OnFlix: ${contentRow.sinhala_subtitle_url}`);
          await set({ status: "completed", error_log: null });
          return "completed";
        }
      }
    }

    // Sequential gate (automatic runs only): a TV episode never publishes before its previous episode.
    if (!opts.manual) {
      const blocker = await previousEpisodeBlocker(sb, j);
      if (blocker) {
        await set({ status: j.status === "upcoming" ? "upcoming" : "waiting_embed", next_retry_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), error_log: `[Sequential] Waiting for ${blocker} to publish first` });
        log(`  ⏸ waiting — ${blocker} must publish first`); return "waiting_previous";
      }
    }

    log("@@step:embed"); log(`  checking video on EmbedMaster…`);
    if (!(await probeEmbed(s, j, log))) {
      await set({ status: "waiting_embed", attempts, next_retry_at: embedRetryAt(), error_log: "No embed sources yet" });
      log(`  waiting for video`); return "waiting_embed";
    }
    // Smart update: reuse an already-translated Sinhala SRT if it exists in storage
    const existingPath = j.media_type === "movie"
      ? `movies/${j.tmdb_id}.si.srt`
      : `tv/${j.tmdb_id}/s${j.season_number}e${j.episode_number}.si.srt`;
    const draftPath = `review/${existingPath}`;
    const put = (p: string, body: string) =>
      sb.storage.from(s.bucket).upload(p, new Blob([sanitizeSinhalaSrt(body)], { type: "application/x-subrip" }), { upsert: true, contentType: "application/x-subrip" });
    const read = async (p: string) => {
      const r = await sb.storage.from(s.bucket).download(p).catch(() => ({ data: null }));
      return r?.data ? await r.data.text() : "";
    };
    // Pause for watermark review (manual only); returns true when we stopped
    const needsReview = async (srt: string) => {
      if (!opts.manual || opts.review) return false;
      const issues = checkWatermark(srt);
      if (!issues.length) { log(`  watermark check: OK`); return false; }
      const up = await put(draftPath, srt);
      if (up.error) throw new Error(`Draft upload: ${up.error.message}`);
      log(`  ⚠ watermark check: ${issues.length} issue(s) — waiting for your confirmation`);
      opts.onIssues?.(issues);
      return true;
    };
    // Approved review: publish the saved draft (fixed or as-is)
    if (opts.review) {
      const draft = await read(draftPath);
      if (draft.trim()) {
        const final = opts.review === "fix" ? addWatermark(draft) : draft;
        log("@@step:srt"); log("@@step:clean"); log("@@step:translate"); log("@@pct:1/1");
        log(`  review approved — ${opts.review === "fix" ? "watermark fixed" : "publishing as-is"}`);
        log("@@step:upload");
        const up = await put(existingPath, final);
        if (up.error) throw new Error(`Upload: ${up.error.message}`);
        await sb.storage.from(s.bucket).remove([draftPath]).catch(() => {});
        const url = sb.storage.from(s.bucket).getPublicUrl(existingPath).data.publicUrl;
        log("@@step:publish"); log(`  publishing to OnFlix…`);
        const c = await upsertOnflix(sb, s, j, url);
        await syncTrending(sb, log);
        await revalidateOnflixWeb(s, c, j, log);
        await set({ status: "completed", attempts, srt_path: existingPath, srt_url: url, srt_preview: final.slice(0, 4000), error_log: null, next_retry_at: null });
        await autoQueueNextEpisode(sb, j, log);
        log(`  ✓ completed — ${url}`); return "completed";
      }
    }
    const existingSi = await read(existingPath);
    if (existingSi.trim()) {
      if (await needsReview(existingSi)) return markNeedsReview("Watermark check requires approval", existingSi);
      log("@@step:srt"); log(`  Sinhala subtitle already exists — skipping download & translation`);
      if (hasForeignScript(existingSi)) {
        const repaired = await put(existingPath, existingSi);
        if (repaired.error) throw new Error(`Upload: ${repaired.error.message}`);
        log(`  fixed other-language letters in the existing Sinhala subtitle`);
      }
      log("@@step:clean"); log("@@step:translate"); log("@@pct:1/1");
      log("@@step:upload");
      const url = sb.storage.from(s.bucket).getPublicUrl(existingPath).data.publicUrl;
      log("@@step:publish"); log(`  updating missing details (embed link etc.) on OnFlix…`);
      const c = await upsertOnflix(sb, s, j, url);
      await syncTrending(sb, log);
      await revalidateOnflixWeb(s, c, j, log);
      await set({ status: "completed", attempts, srt_path: existingPath, srt_url: url, srt_preview: existingSi.slice(0, 4000), error_log: null, next_retry_at: null });
      await autoQueueNextEpisode(sb, j, log);
      log(`  ✓ completed (fast update) — ${url}`); return "completed";
    }
    log("@@step:srt"); log(`  fetching English SRT (SubDL → Wyzie)…`);
    // Video length for the cut check (TMDB). Old movie jobs may lack it, so look it up once.
    let runtimeMin = Number(j.runtime) || null;
    if (!runtimeMin && j.media_type === "movie") runtimeMin = Number((await tmdb(`/movie/${j.tmdb_id}`).catch(() => null))?.runtime) || null;
    if (!runtimeMin) log(`  length check skipped — video length unknown on TMDB`);
    const cut = newCutCheck(runtimeMin);
    const raw = await fetchEnglishSrt(j, s, log, cut);
    if (!raw && cut.rejected.length) {
      await set({ status: "waiting_subtitle", attempts, next_retry_at: retryAt(), error_log: `[Wrong cut] ${cut.rejected[0]} — no matching English sub yet` });
      log(`  ⚠ only English subs for a different cut were found — not translating; will check again later`);
      return "waiting_subtitle";
    }
    if (!raw) {
      await set({ status: "waiting_subtitle", attempts, next_retry_at: retryAt(), error_log: "No English SRT on Wyzie" });
      log(`  waiting for subtitle`); return "waiting_subtitle";
    }
    log("@@step:clean");
    const { srt: en, removed } = cleanSrt(raw);
    log(`  cleaned watermarks/ads (${removed} cue${removed === 1 ? "" : "s"} removed)`);
    if (!en.trim()) throw new Error("Subtitle empty after cleaning");
    log("@@step:translate");
    const enCues = parseSrt(en);
    // Resume from a QA checkpoint (saved when the final review stopped on Gemini quota/overload)
    let cachedPolished = opts.cachedPolishedCues;
    if (!cachedPolished) {
      const cp = parseSrt(await read(`qa-checkpoint/${existingPath}`));
      if (cp.length === enCues.length && cp.every((c, i) => c.index === enCues[i]?.index && c.time === enCues[i]?.time)) {
        cachedPolished = Object.fromEntries(cp.map((c, i) => [String(i + 1), c.text]));
        log(`  restored ${cp.length} translated lines from the saved checkpoint — only the rest will be translated`);
      }
    }
    log(`  translating with Gemini (${geminiKeys().length} key(s) active)…`);
    const polishedCues = await polishCues(enCues, [], log, {
      cachedCues: cachedPolished,
      onChunkDone: opts.onPolishedChunk,
      fallbackTranslate: (t) => gtx(t),
    });
    opts.onTranslated?.(buildSrt(polishedCues));
    const si = sanitizeSinhalaSrt(addWatermark(buildSrt(polishedCues)));
    log(`  added OnFlix watermark (start + end)`);
    if (await needsReview(si)) return markNeedsReview("Watermark check requires approval", si);
    const path = j.media_type === "movie"
      ? `movies/${j.tmdb_id}.si.srt`
      : `tv/${j.tmdb_id}/s${j.season_number}e${j.episode_number}.si.srt`;
    log("@@step:upload"); log(`  uploading to storage…`);
    const up = await sb.storage.from(s.bucket).upload(path, new Blob([si], { type: "application/x-subrip" }), { upsert: true, contentType: "application/x-subrip" });
    if (up.error) throw new Error(`Upload: ${up.error.message}`);
    const url = sb.storage.from(s.bucket).getPublicUrl(path).data.publicUrl;
    log("@@step:publish"); log(`  publishing to OnFlix…`);
    const c = await upsertOnflix(sb, s, j, url);
    await syncTrending(sb, log);
    await revalidateOnflixWeb(s, c, j, log);
    await set({ status: "completed", srt_path: path, srt_url: url, srt_preview: si.slice(0, 4000), error_log: null, next_retry_at: null });
    await sb.storage.from(s.bucket).remove([`qa-checkpoint/${path}`]).catch(() => {});
    log(`  ✓ completed — ${url}`);
    await autoQueueNextEpisode(sb, j, log);
    return "completed";
  } catch (e) {
    if (e instanceof FinalReviewError && e.temporary) {
      // Keep completed work when leftover translation or final QA hits quota/overload.
      const cpPath = `qa-checkpoint/${j.media_type === "movie" ? `movies/${j.tmdb_id}.si.srt` : `tv/${j.tmdb_id}/s${j.season_number}e${j.episode_number}.si.srt`}`;
      opts.onPolishedChunk?.(e.cues.map((cue, i) => [i + 1, cue.text]));
      const up = await sb.storage.from(s.bucket).upload(cpPath, new Blob([sanitizeSinhalaSrt(buildSrt(e.cues))], { type: "application/x-subrip" }), { upsert: true, contentType: "application/x-subrip" });
      await set({
        status: "failed",
        attempts,
        next_retry_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        error_log: `[QA_WAITING] ${e.message} — Gemini quota; continues from saved lines in 30 min`,
        srt_preview: sanitizeSinhalaSrt(buildSrt(e.cues)).slice(0, 4000),
      });
      log(`  ⏸ QA waiting: ${up.error ? "checkpoint save failed, " : "polished cues saved, "}continues from saved lines in 30 min`);
      return "qa_waiting";
    }
    if (e instanceof FinalReviewError) {
      const preview = sanitizeSinhalaSrt(addWatermark(buildSrt(e.cues)));
      return markNeedsReview(e.message, preview);
    }
    const msg = `${e instanceof PolishError && e.blocked ? "[Gemini blocked] " : ""}${(e as Error).message}`;
    const retry = e instanceof PolishError && e.retryAfterSeconds > 0
      ? new Date(Date.now() + Math.max(e.retryAfterSeconds * 1000, s.retryHours * 36e5)).toISOString() : retryAt();
    await set({ status: "failed", attempts, next_retry_at: retry, error_log: msg });
    log(`  ✗ ${msg}`); return "failed";
  } finally {
    clearInterval(heartbeat);
  }
}

/* ---------------- Manual trigger by TMDB ID ---------------- */
export async function runManual(
  input: {
    tmdbId: number;
    mediaType: "movie" | "tv";
    season?: number | undefined;
    episode?: number | undefined;
    review?: "fix" | "keep" | undefined;
    cachedTranslatedSrt?: string | undefined;
    cachedPolishedCues?: Record<string | number, string> | undefined;
    onTranslated?: ((srt: string) => void) | undefined;
    onPolishedChunk?: ((cues: [number, string][]) => void) | undefined;
  },
  log: Log = () => {},
) {
  let issues: WatermarkIssue[] = [];
  const s = await getSettings();
  const sb = db();
  log("@@step:tmdb");
  log(`Fetching TMDB metadata for ${input.mediaType} ${input.tmdbId}…`);
  const d = await tmdb(`/${input.mediaType}/${input.tmdbId}`);
  let job: any;
  if (input.mediaType === "movie") {
    job = {
      tmdb_id: d.id, media_type: "movie", title: d.title, season_number: 0, episode_number: 0,
      release_date: d.release_date || null, popularity: d.popularity, runtime: d.runtime, poster_path: d.poster_path,
    };
  } else {
    if (!input.season || !input.episode) throw new Error("Season and episode are required for TV shows");
    const ep = await tmdb(`/tv/${input.tmdbId}/season/${input.season}/episode/${input.episode}`);
    job = {
      tmdb_id: d.id, media_type: "tv", title: `${d.name} S${input.season}E${input.episode}`,
      season_number: input.season, episode_number: input.episode, release_date: ep.air_date || null,
      popularity: d.popularity, runtime: ep.runtime ?? null, poster_path: d.poster_path,
    };
  }
  log(`Found: ${job.title}`);
  const { data: inserted, error } = await sb
    .from("subtitle_automation_jobs")
    .upsert({ ...job, status: "waiting_embed", next_retry_at: null, updated_at: new Date().toISOString() },
      { onConflict: "tmdb_id,media_type,season_number,episode_number", ignoreDuplicates: true })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  let row = inserted;
  if (!row) {
    const existing = await sb.from("subtitle_automation_jobs").select("*")
      .eq("tmdb_id", job.tmdb_id)
      .eq("media_type", job.media_type)
      .eq("season_number", job.season_number)
      .eq("episode_number", job.episode_number)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    row = existing.data;
  }
  if (!row) throw new Error("Could not load the queue job after insert");
  const status = await processJob(sb, s, row, log, {
    manual: true,
    review: input.review,
    cachedTranslatedSrt: input.cachedTranslatedSrt,
    cachedPolishedCues: input.cachedPolishedCues,
    onTranslated: input.onTranslated,
    onPolishedChunk: input.onPolishedChunk,
    onIssues: (i) => { issues = i; },
  });
  return { status, title: job.title, issues };
}

export async function runDailyCuration(sb: SupabaseClient, log: Log = () => {}, force = false) {
  const todayStr = today();
  try {
    // 1. Check if already curated today
    if (!force) {
      const { data: lastRun } = await sb
        .from("site_settings")
        .select("value")
        .eq("key", "last_daily_curation_date")
        .maybeSingle();
      if (lastRun?.value === todayStr) {
        return { curated: false, reason: "already_curated_today" };
      }
    }

    log(`  [Daily Curation] Auto-curating Top 10 and Hero Slider by highest rating for ${todayStr}…`);
    const now = new Date().toISOString();

    // 2. Curate Top 10 Movies by highest rating & vote count
    const { data: topMovies } = await sb
      .from("content")
      .select("id, title, rating, vote_count")
      .eq("type", "movie")
      .eq("status", "published")
      .order("rating", { ascending: false })
      .order("vote_count", { ascending: false })
      .limit(10);
    const movieIds = (topMovies ?? []).map((m: any) => m.id);

    // 3. Curate Top 10 TV Shows by highest rating & vote count
    const { data: topShows } = await sb
      .from("content")
      .select("id, title, rating, vote_count")
      .neq("type", "movie")
      .eq("status", "published")
      .order("rating", { ascending: false })
      .order("vote_count", { ascending: false })
      .limit(10);
    const showIds = (topShows ?? []).map((t: any) => t.id);

    // 4. Curate Hero Slider (Featured) - strictly 7 to 8 highest-rated published titles
    const { data: topFeatured } = await sb
      .from("content")
      .select("id, title, rating, vote_count")
      .eq("status", "published")
      .order("rating", { ascending: false })
      .order("vote_count", { ascending: false })
      .limit(8);
    const featuredIds = (topFeatured ?? []).map((f: any) => f.id);

    if (featuredIds.length > 0) {
      await sb.from("content").update({ featured: false, updated_at: now }).eq("featured", true);
      await sb.from("content").update({ featured: true, updated_at: now }).in("id", featuredIds);
    }

    // 5. Save Top 10 to top_ten and top_ten_rels
    const { data: parent } = await sb.from("top_ten").select("id").order("id").limit(1).maybeSingle();
    let pid = parent?.id;
    if (!pid) {
      const ins = await sb.from("top_ten").insert({ created_at: now, updated_at: now }).select("id").single();
      pid = ins.data?.id;
    }
    if (pid) {
      if (movieIds.length > 0) {
        await sb.from("top_ten_rels").delete().eq("parent_id", pid).eq("path", "top_10_movies");
        await sb.from("top_ten_rels").insert(movieIds.map((content_id, i) => ({ parent_id: pid, path: "top_10_movies", content_id, order: i + 1 })));
      }
      if (showIds.length > 0) {
        await sb.from("top_ten_rels").delete().eq("parent_id", pid).eq("path", "top_10_tv_shows");
        await sb.from("top_ten_rels").insert(showIds.map((content_id, i) => ({ parent_id: pid, path: "top_10_tv_shows", content_id, order: i + 1 })));
      }
      await sb.from("top_ten").update({ updated_at: now }).eq("id", pid);
    }

    // 6. Save to site_settings
    await sb.from("site_settings").upsert([
      { key: "top_10_movies", value: JSON.stringify(movieIds), updated_at: now },
      { key: "top_10_tv_shows", value: JSON.stringify(showIds), updated_at: now },
      { key: "last_daily_curation_date", value: todayStr, updated_at: now },
    ], { onConflict: "key" });

    // 7. Revalidate website cache
    try {
      const s = await getSettings();
      await revalidateOnflixWeb(s, null, { tmdb_id: 0, media_type: "movie" });
    } catch { /* best-effort */ }

    log(`  ✓ [Daily Curation] Auto-curated Top 10 Movies (${movieIds.length}), Top 10 Series (${showIds.length}), Hero Slider (${featuredIds.length} titles featured)`);
    return { curated: true, movies: movieIds.length, shows: showIds.length, featured: featuredIds.length };
  } catch (err) {
    log(`  [Daily Curation] Skipped: ${(err as Error).message}`);
    return { curated: false, error: (err as Error).message };
  }
}

export async function runProcess(rawLog: Log = () => {}, options: { force?: boolean } = {}) {
  let polishStopped = false;
  const log: Log = (m) => {
    if (/✗.*(?:Gemini|polish|Base translation cue)/i.test(m)) polishStopped = true;
    if (!m.startsWith("@@")) rawLog(m);
  };
  const s = await getSettings();
  const sb = db();

  // Automatic Daily Curation (Top 10 & Hero Slider by highest rating once every 24h)
  await runDailyCuration(sb, log, options.force);

  const nowIso = new Date().toISOString();
  const blocked = await sb.from("subtitle_automation_jobs").select("id")
    .like("error_log", "[Gemini blocked]%").limit(1);
  if (blocked.error) throw new Error(blocked.error.message);
  if (blocked.data?.length) {
    log("Gemini access/configuration needs attention — automatic processing paused; retry the blocked title manually after fixing it");
    return { processed: 0, results: {} };
  }
  // Recover jobs stuck in "processing" (crashed/timed-out runs) so they don't block later episodes forever.
  await sb.from("subtitle_automation_jobs")
    .update({ status: "failed", error_log: "Recovered: previous run stopped mid-process", next_retry_at: null, updated_at: nowIso })
    .eq("status", "processing")
    .lt("updated_at", new Date(Date.now() - 45 * 60 * 1000).toISOString());

  const eligibleJobsQuery = () => sb
    .from("subtitle_automation_jobs")
    .select("*")
    .in("status", ["upcoming", "waiting_embed", "waiting_subtitle", "failed"])
    .lte("release_date", today())
    .lt("attempts", s.maxAttempts)
    .or("error_log.is.null,error_log.not.like.[NEEDS_REVIEW]%");
  let jobs: any[];
  if (options.force) {
    const { data, error } = await eligibleJobsQuery()
      .order("created_at", { ascending: true })
      .order("attempts", { ascending: true })
      .order("popularity", { ascending: false })
      .limit(s.maxBatchSize);
    if (error) throw new Error(error.message);
    jobs = data ?? [];
  } else {
    const [withoutRetry, retryDue] = await Promise.all([
      eligibleJobsQuery().is("next_retry_at", null)
        .order("created_at", { ascending: true })
        .order("attempts", { ascending: true })
        .order("popularity", { ascending: false })
        .limit(s.maxBatchSize),
      eligibleJobsQuery().lte("next_retry_at", nowIso)
        .order("created_at", { ascending: true })
        .order("attempts", { ascending: true })
        .order("popularity", { ascending: false })
        .limit(s.maxBatchSize),
    ]);
    if (withoutRetry.error) throw new Error(withoutRetry.error.message);
    if (retryDue.error) throw new Error(retryDue.error.message);
    jobs = prioritizeQueueJobs([...new Map([...(withoutRetry.data ?? []), ...(retryDue.data ?? [])].map((job) => [job.id, job])).values()])
      .slice(0, s.maxBatchSize);
  }
  // Within the same show, process earlier episodes first so the sequential gate passes in one run.
  const showRank = new Map<number, number>();
  (jobs ?? []).forEach((x: any, i: number) => { if (!showRank.has(x.tmdb_id)) showRank.set(x.tmdb_id, i); });
  jobs?.sort((a: any, b: any) => (showRank.get(a.tmdb_id)! - showRank.get(b.tmdb_id)!)
    || (a.season_number - b.season_number) || (a.episode_number - b.episode_number));
  log(`Picked ${jobs?.length ?? 0} jobs`);
  const results: Record<string, number> = {};
    for (const j of jobs ?? []) {
    if (String(j.error_log ?? "").startsWith("[Gemini blocked]")) {
      log("Gemini access/configuration needs attention — automatic processing paused; retry manually after fixing it");
      break;
    }
    const st = await processJob(sb, s, j, log);
    results[st] = (results[st] ?? 0) + 1;
    if (polishStopped) { log("Gemini polishing stopped — remaining batch deferred"); break; }
  }
  return { processed: Object.values(results).reduce((sum, count) => sum + count, 0), results };
}

/** Episode count per season number for a TV show (from TMDB). */
export async function tvSeasonCounts(tmdbId: number): Promise<Record<number, number>> {
  const d = await tmdb(`/tv/${tmdbId}`);
  const out: Record<number, number> = {};
  return releasedCounts(d);
}

/** Released (already aired) episodes per season, from a TMDB /tv/{id} response. */
export function releasedCounts(d: any): Record<number, number> {
  const out: Record<number, number> = {};
  const last = d.last_episode_to_air;
  for (const s of d.seasons ?? []) {
    const n = s.season_number;
    const total = s.episode_count ?? 0;
    if (!last) out[n] = 0;
    else if (n < last.season_number) out[n] = total;
    else if (n === last.season_number) out[n] = Math.min(total || last.episode_number, last.episode_number);
    else out[n] = 0;
  }
  return out;
}
