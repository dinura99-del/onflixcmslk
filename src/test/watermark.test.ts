import { describe, it, expect } from "vitest";
import { addWatermark, ONFLIX_WATERMARK } from "@/lib/engine.server";

const srt = "1\n00:00:10,000 --> 00:00:12,000\nආයුබෝවන්\n\n2\n00:01:00,000 --> 00:01:02,000\nබායි\n";

describe("addWatermark", () => {
  it("adds OnFlix cue at start and end", () => {
    const out = addWatermark(srt).trim().split("\n\n");
    expect(out).toHaveLength(4);
    expect(out[0]).toContain(ONFLIX_WATERMARK);
    expect(out[3]).toContain("00:01:03,000 --> 00:01:07,000");
    expect(out[3]).toContain(ONFLIX_WATERMARK);
  });
  it("does not duplicate when run twice", () => {
    expect(addWatermark(addWatermark(srt))).toBe(addWatermark(srt));
  });
});
