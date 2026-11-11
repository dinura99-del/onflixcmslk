import { describe, it, expect, vi } from "vitest";
import { gtx, translateSrt } from "@/lib/engine.server";

describe("Google GTX translation", () => {
  it("live: keeps cue numbers and timestamps, outputs Sinhala", async () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,500\nHello, how are you?\n\n2\n00:00:03,000 --> 00:00:04,000\nI am fine.\nThank you.\n";
    const logs: string[] = [];
    const out = await translateSrt(srt, (m) => logs.push(m));
    console.log(out, logs);
    const lines = out.split("\n");
    expect(lines[0]).toBe("1");
    expect(lines[1]).toBe("00:00:01,000 --> 00:00:02,500");
    expect(out).toContain("\n2\n00:00:03,000 --> 00:00:04,000\n");
    expect(out).toMatch(/[\u0D80-\u0DFF]/);
    // With Gemini keys configured, direct Gemini translation runs first; otherwise Google Translate.
    expect(logs.join()).toMatch(/Google Translate|Gemini/);
  }, 30000);
});

import { gtxBatch, parseSrt } from "@/lib/engine.server";
describe("GTX batching", () => {
  it("retries a timed-out request with Google GTX", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockResolvedValueOnce(new Response(JSON.stringify([[ ["ආයුබෝවන්"] ]]), { status: 200 }));
    const retries: string[] = [];
    vi.stubGlobal(
      "fetch",
      fetchMock,
    );
    try {
      await expect(gtx("Hello", { timeoutMs: 5, retryDelayMs: 0, onRetry: (message) => retries.push(message) }))
        .resolves.toBe("ආයුබෝවන්");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(retries).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("live: 60 cues translated in few requests with structure intact", async () => {
    const srt = Array.from({ length: 60 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900\nLine number ${i + 1}.\nSee you tomorrow.`).join("\n\n");
    const cues = parseSrt(srt);
    let calls = 0;
    const out = await gtxBatch(cues, () => {}, async (t) => { calls++; const { gtx } = await import("@/lib/engine.server"); return gtx(t); });
    expect(out.map((c) => c.time)).toEqual(cues.map((c) => c.time));
    expect(out.map((c) => c.index)).toEqual(cues.map((c) => c.index));
    expect(out.every((c) => /[\u0D80-\u0DFF]/.test(c.text))).toBe(true);
    console.log("calls", calls, out[5]);
    expect(calls).toBeLessThan(15);
  }, 60000);
  it("falls back per cue when a batch fails", async () => {
    const cues = parseSrt("1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:03,000 --> 00:00:04,000\nb\n");
    const out = await gtxBatch(cues, () => {}, async (t) => { if (t.includes("\n")) throw new Error("x"); return t.toUpperCase(); });
    expect(out.map((c) => c.text)).toEqual(["A", "B"]);
  });
});

import { googleDraftTranslation } from "@/lib/engine.server";
describe("Two-stage pipeline: Google draft before Gemini polish", () => {
  const three = parseSrt("1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nRun now\n\n3\n00:00:05,000 --> 00:00:06,000\n1984\n");
  it("keeps Sinhala draft lines and blanks lines Google left in English, timing untouched", async () => {
    const map: Record<string, string> = { Hello: "ආයුබෝවන්", "Run now": "Run now", "1984": "1984" };
    const out = await googleDraftTranslation(three, () => {}, async (t) => t.split("\n").map((l) => map[l] ?? l).join("\n"));
    expect(out.map((c) => c.text)).toEqual(["ආයුබෝවන්", "", "1984"]);
    expect(out.map((c) => c.time)).toEqual(three.map((c) => c.time));
  });
  it("returns no draft (Gemini translates directly) when Google is down", async () => {
    const out = await googleDraftTranslation(three, () => {}, async () => { throw new Error("down"); });
    expect(out).toEqual([]);
  });
  it("propagates exhausted GTX timeouts instead of switching to Gemini", async () => {
    const logs: string[] = [];
    const timeout = new DOMException("timeout", "TimeoutError");
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(googleDraftTranslation(
        three,
        (message) => logs.push(message),
        (text) => gtx(text, { timeoutMs: 5, retryDelayMs: 0 }),
      )).rejects.toThrow("3 retries");
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(logs.join(" ")).not.toContain("Gemini will translate directly");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("returns no draft when fewer than half the lines came back in Sinhala", async () => {
    const out = await googleDraftTranslation(three, () => {}, async (t) => t);
    expect(out).toEqual([]);
  });
});
