import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditRequestError, FinalReviewError, generatePolish, geminiKeys, polishCues, PolishError, RateLimitError, validatePolish, isTrivialCue, cleanSinhalaText, lookupTranslationMemory, runFinalQAAudit, hasForeignScript } from "@/lib/gemini-polish.server";
import { buildSrt, parseSrt, sanitizeSinhalaSrt } from "@/lib/engine.server";

const en = parseSrt("7\n00:00:01,123 --> 00:00:02,456\nWhere are you going?\n\n9\n00:00:03,111 --> 00:00:04,999\nI need to find him now.\n");
const si = en.map((cue) => ({ ...cue, text: "මම යනවා." }));
const pairs = [{ id: 1, en: "Hello", si: "ආයුබෝවන්" }, { id: 2, en: "Goodbye", si: "ගිහින් එන්නම්" }];

describe("Gemini overload recovery", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const success = () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ cues: pairs.map((p) => ({ id: p.id, text: p.si })) }) }] } }] });
  it("uses Gemini 3.1 Flash Lite by default", async () => {
    vi.stubEnv("GEMINI_POLISH_MODEL", "");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => success());
    vi.stubGlobal("fetch", fetchMock);
    await expect(generatePolish("test", pairs, [], new AbortController().signal)).resolves.toContain("ආයුබෝවන්");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/models/gemini-3.1-flash-lite:generateContent");
  });
  it("retries the same model after exactly two seconds on 503", async () => {
    vi.useFakeTimers(); vi.stubEnv("GEMINI_POLISH_MODEL", "gemini-3.5-flash-lite");
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockImplementation(async () => success());
    vi.stubGlobal("fetch", fetchMock);
    const pending = generatePolish("test", pairs, [], new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1999); expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await expect(pending).resolves.toContain("ආයුබෝවන්");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(fetchMock.mock.calls[1]?.[0]);
  });
  it("falls back in order to 3.1 Flash Lite then 3.5 Flash without changing key or dialogue payload", async () => {
    vi.useFakeTimers(); vi.stubEnv("GEMINI_POLISH_MODEL", "gemini-3.5-flash-lite");
    const fetchMock = vi.fn().mockImplementation(async () => fetchMock.mock.calls.length <= 4 ? new Response(null, { status: 503 }) : success());
    vi.stubGlobal("fetch", fetchMock);
    const pending = polishCues(en, si, () => {}, { keys: ["test"] });
    await vi.runAllTimersAsync(); const result = await pending;
    expect(fetchMock.mock.calls.map((call) => String(call[0]).split("/models/")[1])).toEqual([
      "gemini-3.5-flash-lite:generateContent", "gemini-3.5-flash-lite:generateContent",
      "gemini-3.1-flash-lite:generateContent", "gemini-3.1-flash-lite:generateContent", "gemini-3.5-flash:generateContent",
    ]);
    expect(new Set(fetchMock.mock.calls.map((call) => JSON.stringify(call[1]))).size).toBe(1);
    expect(result.map(({ index, time }) => ({ index, time }))).toEqual(en.map(({ index, time }) => ({ index, time })));
  });
  it("stops after at most eight overload requests without returning partial text", async () => {
    vi.useFakeTimers(); vi.stubEnv("GEMINI_POLISH_MODEL", "gemini-3.5-flash-lite");
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 })); vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(generatePolish("test", pairs, [], new AbortController().signal)).rejects.toThrow("HTTP 503");
    await vi.runAllTimersAsync(); await assertion; expect(fetchMock).toHaveBeenCalledTimes(8);
  });
  it.each([400, 401, 403, 404])("does not switch models or retry on HTTP %s", async (status) => {
    vi.stubEnv("GEMINI_POLISH_MODEL", "gemini-3.5-flash-lite");
    const fetchMock = vi.fn(async () => new Response(null, { status })); vi.stubGlobal("fetch", fetchMock);
    await expect(generatePolish("test", pairs, [], new AbortController().signal)).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("throws RateLimitError (not a hard stop) on HTTP 429 so the caller can rotate keys", async () => {
    vi.stubEnv("GEMINI_POLISH_MODEL", "gemini-3.5-flash-lite");
    const fetchMock = vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": "10" } }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await generatePolish("test", pairs, [], new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBeGreaterThanOrEqual(10000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rotates to the next key on 429 and completes without failure", async () => {
    vi.useFakeTimers(); vi.stubEnv("GEMINI_POLISH_MODEL", "gemini-3.5-flash-lite");
    // Returns a correct response for whatever cue IDs are in the request body.
    const makeSiResponse = (body: string) => {
      try {
        const outer = JSON.parse(body);
        const innerText = outer.contents?.[0]?.parts?.[0]?.text;
        const inner = innerText ? JSON.parse(innerText) : outer;
        const targets = inner.targets ?? pairs;
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
          cues: targets.map((t: { id: number }) => ({ id: t.id, text: "සිංහල දෙබස" })),
        }) }] } }] });
      } catch {
        return success();
      }
    };
    const usedKeys: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const usedKey = (init.headers as Record<string, string>)["x-goog-api-key"] ?? "";
      usedKeys.push(usedKey);
      return usedKey === "key-a" ? new Response(null, { status: 429, headers: { "retry-after": "1" } })
        : makeSiResponse(init.body as string);
    });
    vi.stubGlobal("fetch", fetchMock);
    // 1 chunk (2 cues), 2 keys — worker-1 starts on key-a, hits 429, rotates to key-b
    const pending = polishCues(en, si, () => {}, { keys: ["key-a", "key-b"] });
    await vi.runAllTimersAsync();
    await pending;
    // key-b must have been used after key-a was rate-limited
    expect(usedKeys).toContain("key-a");
    expect(usedKeys).toContain("key-b");
    expect(usedKeys.indexOf("key-b")).toBeGreaterThan(usedKeys.indexOf("key-a"));
  });
  it("shares a 429 cooldown across workers so no other worker reuses the cooling key", async () => {
    vi.useFakeTimers(); vi.stubEnv("GEMINI_POLISH_MODEL", "gemini-3.5-flash-lite");
    const fourEn = Array.from({ length: 4 }, (_, i) => ({ index: String(i + 1), time: `00:00:0${i},000 --> 00:00:0${i},900`, text: `Line number ${i + 1} here` }));
    const fourSi = fourEn.map((c) => ({ ...c, text: "සිංහල දෙබස" }));
    const calls: { key: string; at: number }[] = [];
    let keyA429 = false;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["x-goog-api-key"] ?? "";
      calls.push({ key, at: Date.now() });
      if (key === "key-a" && !keyA429) { keyA429 = true; return new Response(null, { status: 429, headers: { "retry-after": "1" } }); }
      const inner = JSON.parse(JSON.parse(init.body as string).contents[0].parts[0].text);
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ cues: inner.targets.map((t: { id: number }) => ({ id: t.id, text: "සිංහල දෙබස" })) }) }] } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = polishCues(fourEn, fourSi, () => {}, { keys: ["key-a", "key-b", "key-c"], chunkSize: 1, maxWorkers: 2, audit: false });
    await vi.runAllTimersAsync(); await pending;
    const hitAt = calls.find((c) => c.key === "key-a")!.at;
    // key-a must not be used again by any worker within its 10s cooldown
    expect(calls.filter((c) => c.key === "key-a" && c.at > hitAt && c.at < hitAt + 10000)).toHaveLength(0);
  });
  it("cancels the two-second wait when another worker stops the run", async () => {
    vi.useFakeTimers(); vi.stubEnv("GEMINI_POLISH_MODEL", "gemini-3.5-flash-lite");
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 })); vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const assertion = expect(generatePolish("test", pairs, [], controller.signal)).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await assertion;
    await vi.runAllTimersAsync(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Gemini subtitle polish", () => {
  it("collects primary, comma-separated and numbered keys in numeric order without duplicates", () => {
    expect(geminiKeys({ GEMINI_API_KEY: "a,b", GEMINI_API_KEY_10: "d", GEMINI_API_KEY_03: "c", GEMINI_API_KEY_1: "b" })).toEqual(["a", "b", "c", "d"]);
  });
  it("preserves exact timestamps, original IDs and order despite reordered AI output", async () => {
    const result = await polishCues(en, si, () => {}, { keys: ["test"], generate: async () => JSON.stringify({ cues: [
      { id: 2, text: "මට දැන්ම එයාව හොයාගන්න ඕනෙ." }, { id: 1, text: "ඔයා කොහෙද යන්නේ?" },
    ] }) });
    expect(result.map(({ index, time }) => ({ index, time }))).toEqual([
      { index: "7", time: "00:00:01,123 --> 00:00:02,456" }, { index: "9", time: "00:00:03,111 --> 00:00:04,999" },
    ]);
    expect(result.map((cue) => cue.text)).toEqual(["ඔයා කොහෙද යන්නේ?", "මට දැන්ම එයාව හොයාගන්න ඕනෙ."]);
    expect(parseSrt(buildSrt(result))).toEqual(result);
    expect(si[0]?.text).toBe("මම යනවා.");
  });
  it("never supplies timestamps to the AI", async () => {
    await polishCues(en, si, () => {}, { keys: ["test"], generate: async (_, targets, context) => {
      expect(JSON.stringify({ targets, context })).not.toContain("00:00:");
      return JSON.stringify({ cues: targets.map((target) => ({ id: target.id, text: target.si })) });
    } });
  });
  it.each([
    ["missing cue", [{ id: 1, text: "හරි" }]],
    ["duplicate cue", [{ id: 1, text: "හරි" }, { id: 1, text: "හරි" }]],
    ["unknown cue", [{ id: 1, text: "හරි" }, { id: 3, text: "හරි" }]],
    ["empty cue", [{ id: 1, text: "හරි" }, { id: 2, text: " " }]],
    ["English-only cue", [{ id: 1, text: "හරි" }, { id: 2, text: "Goodbye" }]],
    ["SRT injection", [{ id: 1, text: "හරි" }, { id: 2, text: "හරි\n00:00:01 --> 00:00:02" }]],
  ])("rejects %s rather than publishing a defective subtitle", (_, cues) => {
    expect(() => validatePolish(pairs, JSON.stringify({ cues }))).toThrow(PolishError);
  });
  it("accepts names, acronyms and numbers kept in English, but still rejects untranslated everyday words", () => {
    const named = [{ id: 1, en: "Rachel!", si: "" }, { id: 2, en: "FBI", si: "" }, { id: 3, en: "Harvey Dent!", si: "" }, { id: 4, en: "1984", si: "" }];
    const out = validatePolish(named, JSON.stringify({ cues: [{ id: 1, text: "Rachel!" }, { id: 2, text: "FBI" }, { id: 3, text: "Harvey Dent!" }, { id: 4, text: "1984" }] }));
    expect([...out.values()]).toEqual(["Rachel!", "FBI", "Harvey Dent!", "1984"]);
    expect(() => validatePolish([{ id: 1, en: "Goodbye", si: "" }], JSON.stringify({ cues: [{ id: 1, text: "Goodbye" }] }))).toThrow(PolishError);
    expect(() => validatePolish([{ id: 1, en: "Rachel!", si: "" }], JSON.stringify({ cues: [{ id: 1, text: "Monica!" }] }))).toThrow(PolishError);
  });
  it("refuses to publish when dialogue lines are still English after every retry", async () => {
    vi.useFakeTimers(); vi.stubEnv("GEMINI_POLISH_MODEL", "gemini-3.5-flash-lite");
    const fetchMock = vi.fn(async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = polishCues(en, [], () => {}, { keys: ["test"], audit: false });
    const check = expect(pending).rejects.toThrow("still in English");
    await vi.runAllTimersAsync();
    await check;
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  it("re-translates a failing chunk in small groups so the good lines still become Sinhala", async () => {
    vi.useFakeTimers(); vi.stubEnv("GEMINI_POLISH_MODEL", "gemini-3.5-flash-lite");
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      // First 4 chunk attempts (x2 validation tries) fail, then small groups succeed.
      const text = calls <= 8 ? "not json" : JSON.stringify({ cues: [{ id: 1, text: "ඔයා කොහෙද යන්නේ?" }, { id: 2, text: "මට එයාව දැන්ම හොයාගන්න ඕනේ." }] });
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] });
    }));
    const pending = polishCues(en, [], () => {}, { keys: ["test"], audit: false });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.map((c) => c.text)).toEqual(["ඔයා කොහෙද යන්නේ?", "මට එයාව දැන්ම හොයාගන්න ඕනේ."]);
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  it("rejects base translation cue/timestamp mismatch before calling AI", async () => {
    let called = false;
    await expect(polishCues(en, [{ ...si[0], index: "7", time: "changed", text: "හරි" }, si[1] as typeof en[number]], () => {}, {
      keys: ["test"], generate: async () => { called = true; return ""; },
    })).rejects.toThrow("do not match");
    expect(called).toBe(false);
  });
  it("runs chunks in parallel on different keys and reconstructs by ID", async () => {
    let active = 0, peak = 0;
    const used = new Set<string>();
    const result = await polishCues(en, si, () => {}, { keys: ["a", "b"], chunkSize: 1, pauseMs: 0,
      generate: async (key, targets) => {
        used.add(key); active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, key === "a" ? 10 : 1)); active--;
        return JSON.stringify({ cues: targets.map((target) => ({ id: target.id, text: target.id === 1 ? "ඔයා කොහෙද යන්නේ?" : "මට එයාව හොයාගන්න ඕනෙ." })) });
      },
    });
    expect(peak).toBe(2); expect([...used]).toEqual(["a", "b"]);
    expect(result.map((cue) => cue.index)).toEqual(["7", "9"]);
  });
  it("scales up to 7 workers when 7 keys are provided", async () => {
    vi.stubEnv("GEMINI_MAX_WORKERS", "7");
    vi.stubEnv("GEMINI_CHUNK_SIZE", "75");
    let active = 0, peak = 0;
    const testKeys = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"];
    const testEn = Array.from({ length: 70 }, (_, i) => ({ index: String(i + 1), time: `00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},999`, text: `Line number ${i + 1} here` }));
    const testSi = testEn.map((cue) => ({ ...cue, text: "සිංහල" }));
    const logs: string[] = [];
    await polishCues(testEn, testSi, (message) => logs.push(message), {
      keys: testKeys, pauseMs: 0,
      generate: async (_, targets) => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 15)); active--;
        return JSON.stringify({ cues: targets.map((t) => ({ id: t.id, text: "සිංහල දෙබස" })) });
      },
    });
    expect(peak).toBe(7);
    expect(logs.some((message) => /Gemini Flash polish: \d+ chunks, 7 parallel worker\(s\)/.test(message))).toBe(true);
    vi.unstubAllEnvs();
  });
  it("halts on denial without switching credentials or publishing partial work", async () => {
    let calls = 0;
    await expect(polishCues(en, si, () => {}, { keys: ["a", "b"], chunkSize: 1,
      generate: async () => { calls++; throw new PolishError("denied", true); },
    })).rejects.toThrow("denied");
    expect(calls).toBeLessThanOrEqual(2);
  });
  it("translates song lyrics and sound tags into Sinhala, only skipping wordless music cues", async () => {
    const mixedEn = [
      { index: "1", time: "00:00:01,000 --> 00:00:02,000", text: "♪ Never gonna give you up ♪" },
      { index: "2", time: "00:00:03,000 --> 00:00:04,000", text: "Where are you going?" },
      { index: "3", time: "00:00:05,000 --> 00:00:06,000", text: "[Theme song playing]" },
      { index: "4", time: "00:00:07,000 --> 00:00:08,000", text: "♪♪" },
    ];
    const mixedSi = [
      { index: "1", time: "00:00:01,000 --> 00:00:02,000", text: "♪ ඔයාව අත්හරින්නේ නෑ ♪" },
      { index: "2", time: "00:00:03,000 --> 00:00:04,000", text: "ඔබ කොහෙද යන්නේ?" },
      { index: "3", time: "00:00:05,000 --> 00:00:06,000", text: "[තේමා ගීතය වාදනය වේ]" },
      { index: "4", time: "00:00:07,000 --> 00:00:08,000", text: "♪♪" },
    ];
    const generatedTargets: number[] = [];
    const result = await polishCues(mixedEn, mixedSi, () => {}, {
      keys: ["test"],
      generate: async (_, targets) => {
        generatedTargets.push(...targets.map((t) => t.id));
        return JSON.stringify({ cues: targets.map((t) => ({ id: t.id, text: "කොහෙද යන්නේ?" })) });
      },
    });
    expect(generatedTargets).toEqual([1, 2, 3]);
    expect(result[0]?.text).toBe("කොහෙද යන්නේ?");
    expect(result[2]?.text).toBe("කොහෙද යන්නේ?");
    expect(result[3]?.text).toBe("♪♪");
  });

  describe("advanced optimization engine", () => {
    it("identifies trivial affirmations, reactions, and numbers for AI bypass", () => {
      expect(isTrivialCue("Yes.", "ඔව්.")).toBe(true);
      expect(isTrivialCue("No!", "නැහැ!")).toBe(true);
      expect(isTrivialCue("Okay", "හරි")).toBe(true);
      expect(isTrivialCue("Thank you.", "ස්තූතියි.")).toBe(true);
      expect(isTrivialCue("100%", "100%")).toBe(true);
      expect(isTrivialCue("2024", "2024")).toBe(true);
      expect(isTrivialCue("Where did he go yesterday?", "ඔහු ඊයේ ගියේ කොහේද?")).toBe(false);
      expect(isTrivialCue("Yes", "")).toBe(false); // empty Sinhala should not bypass
    });

    it("normalizes punctuation and spaces in Sinhala text", () => {
      expect(cleanSinhalaText("කොහෙද යන්නේ ?")).toBe("කොහෙද යන්නේ?");
      expect(cleanSinhalaText("හරි  මම   යන්නම් .")).toBe("හරි මම යන්නම්.");
      expect(cleanSinhalaText("పూర్ණවම වෙනස් ආකෘතියක්")).toBe("පූර්ණවම වෙනස් ආකෘතියක්");
    });

    it("replaces leaked Telugu, Kannada, Malayalam, Tamil and Hindi letters with Sinhala", () => {
      expect(cleanSinhalaText("ලා\u0C13 එක්කද?")).toBe("ලාඕ එක්කද?"); // Telugu ఓ seen in a published subtitle
      expect(cleanSinhalaText("ලා\u0C93 එක්කද?")).toBe("ලාඕ එක්කද?"); // Kannada ಓ
      expect(cleanSinhalaText("ලා\u0D13 එක්කද?")).toBe("ලාඕ එක්කද?"); // Malayalam ഓ
      expect(cleanSinhalaText("\u0B95ොහෙද?")).toBe("කොහෙද?"); // Tamil க
      expect(cleanSinhalaText("\u0915ොහෙද?")).toBe("කොහෙද?"); // Hindi क
      expect(hasForeignScript(cleanSinhalaText("හරි \u0E01 \u1000 යමු"))).toBe(false); // Thai / Myanmar dropped
    });

    it("repairs the Bengali, Punjabi, Gujarati and Greek leaks found in published subtitles", () => {
      expect(cleanSinhalaText("සලකුණු කළ මුදල් ਨෝට්ටු හරහා")).toBe("සලකුණු කළ මුදල් නෝට්ටු හරහා"); // Punjabi ਨ
      expect(cleanSinhalaText("කාලය අපතੇ යවන බව")).toBe("කාලය අපතේ යවන බව"); // Punjabi ੇ
      expect(cleanSinhalaText("මාස ১৮ ක්")).toBe("මාස 18 ක්"); // Bengali digits
      expect(cleanSinhalaText("ඩෝස් මෙනවියව પ્રਭාවයට")).toBe("ඩෝස් මෙනවියව ප්\u200Dරභාවයට"); // Gujarati + Punjabi
      expect(cleanSinhalaText("මගේ ανέี่ยว නරකයි")).toBe("මගේ නරකයි"); // Greek + Thai word dropped
      expect(cleanSinhalaText("Rachel, ♪ හරි ♪ 100%")).toBe("Rachel, ♪ හරි ♪ 100%"); // names, symbols untouched
    });

    it("sends a cue written in another language back for re-translation instead of publishing it", () => {
      const one = [{ id: 1, en: "Where are you going?", si: "" }];
      expect(() => validatePolish(one, JSON.stringify({ cues: [{ id: 1, text: "నువ్వు ఎక్కడికి వెళ్తున్నావు?" }] }))).toThrow(PolishError);
      expect(validatePolish(one, JSON.stringify({ cues: [{ id: 1, text: "ඔයා කොහෙ\u0C26 යන්නේ?" }] })).get(1)).toBe("ඔයා කොහෙද යන්නේ?");
    });

    it("cleans other-language letters out of a whole SRT without touching numbers or timestamps", () => {
      const srt = "1\n00:00:01,000 --> 00:00:02,000\nලා\u0C13 එක්කද?\n";
      expect(sanitizeSinhalaSrt(srt)).toBe("1\n00:00:01,000 --> 00:00:02,000\nලාඕ එක්කද?\n");
    });

    it("matches universal expressions from Translation Memory", () => {
      expect(lookupTranslationMemory("Let's go!")).toBe("යමු!");
      expect(lookupTranslationMemory("Come on.")).toBe("එන්න.");
      expect(lookupTranslationMemory("Watch out!")).toBe("ප්‍රවේශමෙන්!");
      expect(lookupTranslationMemory("Previously on...")).toBe("මීට පෙර");
      expect(lookupTranslationMemory("Random unfamiliar dialogue line")).toBeUndefined();
    });

    it("runs final QA comparison audit and detects potential cue anomalies", async () => {
      const logs: string[] = [];
      const testEn = [
        { index: "1", time: "00:00:01,000 --> 00:00:02,000", text: "Where are you going?" },
        { index: "2", time: "00:00:03,000 --> 00:00:04,000", text: "I am going home." },
      ];
      const testSi = [
        { index: "1", time: "00:00:01,000 --> 00:00:02,000", text: "ඔයා කොහෙද යන්නේ?" },
        { index: "2", time: "00:00:03,000 --> 00:00:04,000", text: "මම ගෙදර යනවා." },
      ];
      const audit = await runFinalQAAudit(testEn, testSi, (m) => logs.push(m), { isTest: true });
      expect(audit.passed).toBe(true);
      expect(audit.checked).toBe(2);
      expect(logs.some((l) => l.includes("Final review"))).toBe(true);
    });

    it("fails the final QA gate when any spoken-line batch is not reviewed", async () => {
      const english = Array.from({ length: 61 }, (_, i) => ({
        index: String(i + 1),
        time: "00:00:01,000 --> 00:00:02,000",
        text: `Spoken line ${i + 1}`,
      }));
      const polished = english.map((cue) => ({ ...cue, text: "සිංහල දෙබස" }));
      let batches = 0;
      const audit = await runFinalQAAudit(english, polished, () => {}, {
        keys: ["test-key"],
        auditBatchFn: async (_key, _model, batch) => {
          batches++;
          return batch[0]!.id === 1 ? { summary: "Reviewed", corrections: [] } : null;
        },
      });
      expect(batches).toBe(2);
      expect(audit).toMatchObject({ passed: false, checked: 60 });
    });

    it("retries a busy (503) review on the same key and marks quota-only failures as temporary", async () => {
      const english = [{ index: "1", time: "00:00:01,000 --> 00:00:02,000", text: "Hello there" }];
      const polished = [{ ...english[0]!, text: "ආයුබෝවන්" }];
      let calls = 0;
      const busyThenOk = await runFinalQAAudit(english, polished.map((c) => ({ ...c })), () => {}, {
        keys: ["k1"], retryDelayMs: 0,
        auditBatchFn: async () => {
          if (++calls === 1) throw new AuditRequestError(503, "UNAVAILABLE");
          return { summary: "ok", corrections: [] };
        },
      });
      expect(calls).toBe(2);
      expect(busyThenOk.passed).toBe(true);

      const quota = await runFinalQAAudit(english, polished.map((c) => ({ ...c })), () => {}, {
        keys: ["k1", "k2"], retryDelayMs: 0,
        auditBatchFn: async () => { throw new AuditRequestError(429, "RESOURCE_EXHAUSTED"); },
      });
      expect(quota).toMatchObject({ passed: false, temporary: true });

      const bad = await runFinalQAAudit(english, polished.map((c) => ({ ...c })), () => {}, {
        keys: ["k1"], retryDelayMs: 0, auditBatchFn: async () => null,
      });
      expect(bad).toMatchObject({ passed: false, temporary: false });
    });

    it("fails closed when the final QA audit has no key", async () => {
      const english = [{ index: "1", time: "00:00:01,000 --> 00:00:02,000", text: "Hello there" }];
      const polished = [{ ...english[0]!, text: "ආයුබෝවන්" }];
      const audit = await runFinalQAAudit(english, polished, () => {}, { keys: [] });
      expect(audit).toMatchObject({ passed: false, checked: 0 });
    });
  });
});
describe("Two-stage pipeline: Gemini polishes a partial Google draft", () => {
  it("does not return publishable cues when the final audit misses a spoken-line batch", async () => {
    const english = Array.from({ length: 61 }, (_, i) => ({
      index: String(i + 1),
      time: `00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900`,
      text: `Spoken line ${i + 1}`,
    }));
    const cuesPromise = polishCues(english, [], () => {}, {
      keys: ["test-key"],
      audit: true,
      pauseMs: 0,
      generate: async (_key, targets) => JSON.stringify({ cues: targets.map((target) => ({ id: target.id, text: "සිංහල දෙබස" })) }),
      auditBatchFn: async (_key, _model, batch) => batch[0]!.id === 1 ? { summary: "Reviewed", corrections: [] } : null,
    });

    await expect(cuesPromise).rejects.toMatchObject({
      name: "FinalReviewError",
      checked: 60,
      total: 61,
    } satisfies Partial<FinalReviewError>);
  });

  it("sends the draft to Gemini and translates blank draft lines from English", async () => {
    const enCues = [
      { index: "1", time: "00:00:01,000 --> 00:00:02,000", text: "Where are you going?" },
      { index: "2", time: "00:00:03,000 --> 00:00:04,000", text: "I need to find him now." },
    ];
    const draft = [{ ...enCues[0]!, text: "ඔයා කොහෙද යන්නේ?" }, { ...enCues[1]!, text: "" }];
    let seen: { si: string }[] = [];
    const result = await polishCues(enCues, draft, () => {}, { keys: ["k"], audit: false, generate: async (_k, targets) => {
      seen = targets;
      return JSON.stringify({ cues: targets.map((t) => ({ id: t.id, text: t.id === 1 ? "ඔයා කොහෙද යන්නේ?" : "මට එයාව දැන්ම හොයාගන්න ඕනේ." })) });
    } });
    expect(seen.map((t) => t.si)).toEqual(["ඔයා කොහෙද යන්නේ?", ""]);
    expect(result.map((c) => c.text)).toEqual(["ඔයා කොහෙද යන්නේ?", "මට එයාව දැන්ම හොයාගන්න ඕනේ."]);
    expect(result.map((c) => c.time)).toEqual(enCues.map((c) => c.time));
  });
});
