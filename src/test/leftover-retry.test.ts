import { afterEach, describe, expect, it, vi } from "vitest";
import { polishCues } from "@/lib/gemini-polish.server";

const keys = Array.from({ length: 18 }, (_, i) => `test-key-${i + 1}`);
const english = Array.from({ length: 492 }, (_, i) => ({
  index: String(i + 1), time: "00:00:01,123 --> 00:00:02,456", text: "Report to base now.",
}));
const cached = Object.fromEntries(english.map((_, i) => [i + 1, i < 490 ? "දැන් කඳවුරට වාර්තා කරන්න." : "Report to base now."]));
const success = (init: RequestInit, text = "දැන් කඳවුරට වාර්තා කරන්න.") => {
  const payload = JSON.parse(JSON.parse(String(init.body)).contents[0].parts[0].text);
  return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
    cues: payload.targets.map((t: { id: number }) => ({ id: t.id, text })),
  }) }] } }] });
};

describe("Leftover Sinhala retries and checkpoint resume", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("uses all 18 keys to translate the last two lines without re-polishing the other 490", async () => {
    vi.useFakeTimers();
    const used: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["x-goog-api-key"] ?? "";
      used.push(key);
      return key === keys[17] ? success(init) : new Response(null, { status: 429 });
    }));
    const pending = polishCues(english, [], () => {}, { keys, cachedCues: cached, audit: false });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(used).toEqual(keys);
    expect(result.every((c) => c.text === "දැන් කඳවුරට වාර්තා කරන්න.")).toBe(true);
    expect(result.map(({ index, time }) => ({ index, time }))).toEqual(english.map(({ index, time }) => ({ index, time })));
  });

  it("waits out the cooldown before reusing a key when the whole pool is limited", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(Date.now());
      return calls.length === 1 ? new Response(null, { status: 429, headers: { "retry-after": "12" } }) : success(init);
    }));
    const pending = polishCues(english, [], () => {}, { keys: ["test"], cachedCues: cached, audit: false });
    await vi.runAllTimersAsync();
    await pending;
    expect(calls).toHaveLength(2);
    expect((calls[1] ?? 0) - (calls[0] ?? 0)).toBeGreaterThanOrEqual(12000);
  });

  it("preserves all 492 timed cues as temporary checkpoint work when every key stays limited", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = polishCues(english, [], () => {}, { keys, cachedCues: cached, audit: false });
    const assertion = expect(pending).rejects.toMatchObject({ name: "FinalReviewError", temporary: true, cues: english.map((c, i) => ({ ...c, text: cached[i + 1] })) });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(36);
  });

  it("rejects Latin dialogue on strict retries, while preserving inline tags and Sinhala phonetics", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      calls++;
      return success(init, calls === 1 ? "<i>Bravo, දැන් එන්න.</i>" : "<i>බ්‍රාවෝ, දැන් එන්න.</i>");
    }));
    const pending = polishCues(english, [], () => {}, { keys: ["test"], cachedCues: cached, audit: false });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(calls).toBe(2);
    expect(result[491]?.text).toBe("<i>බ්‍රාවෝ, දැන් එන්න.</i>");
  });

  it("does not classify repeated invalid content as a quota checkpoint", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] })));
    const pending = polishCues(english, [], () => {}, { keys: ["test"], cachedCues: cached, audit: false });
    const assertion = expect(pending).rejects.toMatchObject({ name: "FinalReviewError", temporary: false });
    await vi.runAllTimersAsync(); await assertion;
  });

  it("runs full final review again after restoring a complete checkpoint", async () => {
    const checked: number[] = [];
    const review = vi.fn(async (_key: string, _model: string, batch: { id: number; en: string; si: string }[]) => {
      checked.push(...batch.map((cue) => cue.id));
      return { summary: "Reviewed", corrections: [] };
    });
    await polishCues(english, [], () => {}, {
      keys, cachedCues: Object.fromEntries(english.map((_, i) => [i + 1, "දැන් කඳවුරට වාර්තා කරන්න."])), auditBatchFn: review,
    });
    expect(review).toHaveBeenCalledTimes(9);
    expect(checked.sort((a, b) => a - b)).toEqual(english.map((_, i) => i + 1));
  });

  it("retains successful repairs from earlier groups when the final group hits quota", async () => {
    vi.useFakeTimers();
    const seven = english.slice(0, 7);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(JSON.parse(String(init.body)).contents[0].parts[0].text);
      return payload.targets[0].id === 1 ? success(init) : new Response(null, { status: 429 });
    }));
    const cachedCues = Object.fromEntries(seven.map((c, i) => [i + 1, c.text]));
    const assertion = expect(polishCues(seven, [], () => {}, { keys: ["test"], cachedCues, audit: false })).rejects.toMatchObject({
      temporary: true,
      cues: seven.map((c, i) => ({ ...c, text: i < 5 ? "දැන් කඳවුරට වාර්තා කරන්න." : c.text })),
    });
    await vi.runAllTimersAsync(); await assertion;
  });
});