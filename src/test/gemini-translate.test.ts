import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanSinhalaText, DEFAULT_MODELS, FinalReviewError, geminiKeys, generatePolish, hasForeignScript, modelPriority,
  parseTranslations, polishCues, RateLimitError, resetGeminiPoolState, type Pair,
} from "@/lib/gemini-polish.server";
import { sanitizeSinhalaSrt } from "@/lib/engine.server";

const cue = (i: number, text: string) => ({ index: String(i), time: `00:00:0${i},123 --> 00:00:0${i},900`, text });
const en = [cue(1, "Where are you going?"), cue(2, "John, wait!"), cue(3, "♪♪"), cue(4, "I love you.")];
const SI: Record<string, string> = { "Where are you going?": "ඔයා කොහෙද යන්නේ?", "John, wait!": "ජෝන්, ඉන්න!", "I love you.": "මම ඔයාට ආදරෙයි." };
const reply = (targets: Pair[], map: (p: Pair) => string | undefined = (p) => SI[p.en] ?? "සිංහල") =>
  JSON.stringify({ cues: targets.flatMap((t) => { const text = map(t); return text === undefined ? [] : [{ id: t.id, text }]; }) });
const quick = { pauseMs: 0 } as const;

beforeEach(() => resetGeminiPoolState());
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Model choice", () => {
  it("starts with Flash-Lite and ignores the old GEMINI_POLISH_MODEL setting", () => {
    expect(modelPriority({ GEMINI_POLISH_MODEL: "gemini-3.8-flash" })[0]).toBe("gemini-3.5-flash-lite");
    expect(modelPriority({})).toEqual(DEFAULT_MODELS);
  });
  it("uses GEMINI_MODEL_ORDER when set", () => {
    expect(modelPriority({ GEMINI_MODEL_ORDER: "gemini-3.6-flash, gemini-3.1-flash-lite" })).toEqual(["gemini-3.6-flash", "gemini-3.1-flash-lite"]);
  });
  it("appends the requested models without changing the existing priority", () => {
    expect(modelPriority({})).toEqual([
      "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash",
      "gemini-3.8-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro",
    ]);
  });
  it("collects primary, comma-separated and numbered keys in order without duplicates", () => {
    expect(geminiKeys({ GEMINI_API_KEY_2: "c", GEMINI_API_KEY: "a,b", GEMINI_API_KEY_1: "b", OTHER: "x" })).toEqual(["a", "b", "c"]);
  });
});

describe("Direct translation", () => {
  it("keeps every timestamp and number, and never sends timestamps to Gemini", async () => {
    const sent: string[] = [];
    const out = await polishCues(en, [], () => {}, { ...quick, keys: ["k"], generate: async (_k, targets, context) => {
      sent.push(JSON.stringify({ targets, context }));
      return reply(targets);
    } });
    expect(out.map((c) => c.time)).toEqual(en.map((c) => c.time));
    expect(out.map((c) => c.index)).toEqual(en.map((c) => c.index));
    expect(out.map((c) => c.text)).toEqual(["ඔයා කොහෙද යන්නේ?", "ජෝන්, ඉන්න!", "♪♪", "මම ඔයාට ආදරෙයි."]);
    expect(sent.join()).not.toMatch(/-->|00:00/);
  });

  it("does not send wordless music cues to Gemini", async () => {
    const asked: string[] = [];
    await polishCues(en, [], () => {}, { ...quick, keys: ["k"], generate: async (_k, t) => { asked.push(...t.map((p) => p.en)); return reply(t); } });
    expect(asked).not.toContain("♪♪");
  });

  it("re-asks only the lines that came back missing, keeping the good ones", async () => {
    const calls: number[][] = [];
    const out = await polishCues(en, [], () => {}, { ...quick, keys: ["k"], generate: async (_k, t) => {
      calls.push(t.map((p) => p.id));
      return calls.length === 1 ? reply(t, (p) => (p.id === 4 ? undefined : SI[p.en])) : reply(t);
    } });
    expect(calls).toEqual([[1, 2, 4], [4]]);
    expect(out[3]!.text).toBe("මම ඔයාට ආදරෙයි.");
  });

  it("uses the Google fallback for a line Gemini keeps leaving in English", async () => {
    const out = await polishCues(en, [], () => {}, { ...quick, keys: ["k"],
      generate: async (_k, t) => reply(t, (p) => (p.id === 1 ? "Where are you going?" : SI[p.en])),
      fallbackTranslate: async () => "ඔබ කොහෙද යන්නේ?" });
    expect(out[0]!.text).toBe("ඔබ කොහෙද යන්නේ?");
  });

  it("stops for review instead of publishing when many spoken lines are still English", async () => {
    const many = Array.from({ length: 10 }, (_, i) => cue(i + 1, `Please open the door number ${i}.`));
    const run = polishCues(many, [], () => {}, { ...quick, keys: ["k"], generate: async (t0, t) => reply(t, (p) => p.en) });
    await expect(run).rejects.toMatchObject({ name: "FinalReviewError", temporary: false });
  });
});

describe("No Groq fallback", () => {
  it("never calls Groq, even when Gemini and Google Translate both fail", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string | URL | Request) => {
      urls.push(String(u));
      if (String(u).includes("mymemory")) return Response.json({ responseStatus: 200, responseData: { translatedText: "හරි" } });
      return new Response("down", { status: 500 });
    }));
    const { translateSrt } = await import("@/lib/engine.server");
    await translateSrt("1\n00:00:01,000 --> 00:00:02,000\nHello there.\n", () => {}).catch(() => "");
    expect(urls.some((u) => /groq/i.test(u))).toBe(false);
  }, 60_000);
});

describe("Reply checking", () => {
  const one: Pair[] = [{ id: 1, en: "Where are you going?" }];
  it("rejects a line written in another language so it is asked again", () => {
    expect(parseTranslations(one, JSON.stringify({ cues: [{ id: 1, text: "నువ్వు ఎక్కడికి వెళ్తున్నావు?" }] })).size).toBe(0);
  });
  it("repairs a single leaked letter instead of rejecting the line", () => {
    expect(parseTranslations(one, JSON.stringify({ cues: [{ id: 1, text: "ඔයා කොහෙ\u0C26 යන්නේ?" }] })).get(1)).toBe("ඔයා කොහෙද යන්නේ?");
  });
  it("accepts a name-only line kept in English letters but rejects untranslated dialogue", () => {
    const pairs: Pair[] = [{ id: 1, en: "Rachel!" }, { id: 2, en: "Get out!" }];
    const got = parseTranslations(pairs, JSON.stringify({ cues: [{ id: 1, text: "Rachel!" }, { id: 2, text: "Get out!" }] }));
    expect([...got.keys()]).toEqual([1]);
  });
  it("reads the JSON even when Gemini adds a sentence before or after it", () => {
    const body = JSON.stringify({ cues: [{ id: 1, text: "ඔයා කොහෙද යන්නේ?" }] });
    expect(parseTranslations(one, `Sure, here are the cues:\n\`\`\`json\n${body}\n\`\`\`\nHope this helps!`).get(1)).toBe("ඔයා කොහෙද යන්නේ?");
    expect(parseTranslations(one, `Here is the translated JSON: ${body}`).get(1)).toBe("ඔයා කොහෙද යන්නේ?");
  });
  it("keeps the finished lines from a reply that was cut off midway", () => {
    const pairs: Pair[] = [{ id: 1, en: "Where are you going?" }, { id: 2, en: "John, wait!" }];
    const cut = '{"cues":[{"id":1,"text":"ඔයා කොහෙද යන්නේ?"},{"id":2,"text":"ජෝන්, ඉ';
    const got = parseTranslations(pairs, cut);
    expect([...got.entries()]).toEqual([[1, "ඔයා කොහෙද යන්නේ?"]]);
  });
  it("ignores unknown ids and broken JSON without throwing", () => {
    expect(parseTranslations(one, "not json").size).toBe(0);
    expect(parseTranslations(one, JSON.stringify({ cues: [{ id: 9, text: "හරි" }] })).size).toBe(0);
  });
});

describe("Quota handling", () => {
  it("advances through all requested fallback models when earlier models exhaust daily quota", async () => {
    const seen: string[] = [];
    const out = await polishCues(en, [], () => {}, { ...quick, keys: ["a"], models: modelPriority({}),
      generate: async (_key, targets, _context, _signal, model) => {
        seen.push(model);
        if (model !== "gemini-2.5-pro") throw new RateLimitError(3_600_000, 429, true);
        return reply(targets);
      } });
    expect(seen).toEqual([
      "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash",
      "gemini-3.8-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro",
    ]);
    expect(out[0]?.text).toBe("ඔයා කොහෙද යන්නේ?");
  });
  it("parks a key whose daily quota is gone and finishes on the next key", async () => {
    const used: string[] = [];
    const out = await polishCues(en, [], () => {}, { ...quick, keys: ["a", "b"], models: ["m1"], generate: async (key, t) => {
      used.push(key);
      if (key === "a") throw new RateLimitError(3_600_000, 429, true);
      return reply(t);
    } });
    expect(used).toEqual(["a", "b"]);
    expect(out[0]!.text).toBe("ඔයා කොහෙද යන්නේ?");
  });

  it("switches to the next model when every key has used its daily quota on the first one", async () => {
    const seen: string[] = [];
    await polishCues(en, [], () => {}, { ...quick, keys: ["a", "b"], models: ["big", "lite"], generate: async (key, t, _c, _s, model) => {
      seen.push(`${model}:${key}`);
      if (model === "big") throw new RateLimitError(3_600_000, 429, true);
      return reply(t);
    } });
    expect(seen).toEqual(["big:a", "big:b", "lite:a"]);
  });

  it("saves finished lines and retries later when every key and model is out of quota", async () => {
    const many = Array.from({ length: 4 }, (_, i) => cue(i + 1, `Line number ${i} here.`));
    let calls = 0;
    const run = polishCues(many, [], () => {}, { ...quick, keys: ["a"], models: ["m"], chunkSize: 2, maxWorkers: 1, generate: async (_k, t) => {
      if (++calls > 1) throw new RateLimitError(3_600_000, 429, true);
      return reply(t, () => "හරි");
    } });
    const error = await run.catch((e) => e);
    expect(error).toBeInstanceOf(FinalReviewError);
    expect(error.temporary).toBe(true);
    expect(error.cues.map((c: { text: string }) => c.text)).toEqual(["හරි", "හරි", "Line number 2 here.", "Line number 3 here."]);
  });

  it("resumes from saved lines without asking Gemini for them again", async () => {
    const asked: number[] = [];
    await polishCues(en, [], () => {}, { ...quick, keys: ["k"], cachedCues: { 1: "ඔයා කොහෙද යන්නේ?", 2: "ජෝන්, ඉන්න!" },
      generate: async (_k, t) => { asked.push(...t.map((p) => p.id)); return reply(t); } });
    expect(asked).toEqual([4]);
  });

  it("reads Google's daily-quota 429 as daily and a timeout as retryable", async () => {
    const pairs: Pair[] = [{ id: 1, en: "Hi there friend" }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }, { status: 429 })));
    await expect(generatePolish("k", pairs, [], new AbortController().signal)).rejects.toMatchObject({ daily: true, status: 429 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }));
    await expect(generatePolish("k", pairs, [], new AbortController().signal)).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("Other-language letter clean-up", () => {
  it("replaces leaked Telugu, Tamil, Hindi and Bengali characters with Sinhala", () => {
    expect(cleanSinhalaText("ලා\u0C13 එක්කද?")).toBe("ලාඕ එක්කද?");
    expect(cleanSinhalaText("\u0B95ොහෙද?")).toBe("කොහෙද?");
    expect(cleanSinhalaText("\u0915ොහෙද?")).toBe("කොහෙද?");
    expect(cleanSinhalaText("මාස ১৮ ක්")).toBe("මාස 18 ක්");
    expect(hasForeignScript(cleanSinhalaText("හරි \u0E01 \u1000 යමු"))).toBe(false);
    expect(cleanSinhalaText("Rachel, ♪ හරි ♪ 100%")).toBe("Rachel, ♪ හරි ♪ 100%");
  });
  it("cleans a whole SRT without touching numbers or timestamps", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nලා\u0C13 එක්කද?\n";
    expect(sanitizeSinhalaSrt(srt)).toBe("1\n00:00:01,000 --> 00:00:02,000\nලාඕ එක්කද?\n");
  });
});
