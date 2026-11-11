import { describe, it, expect } from "vitest";
import { addWatermark, checkWatermark, ONFLIX_WATERMARK as W } from "@/lib/engine.server";

const base = "1\n00:00:10,000 --> 00:00:12,000\nආයුබෝවන්\n\n2\n00:01:00,000 --> 00:01:02,000\nබායි\n";

describe("checkWatermark", () => {
  it("clean watermarked subtitle has no issues", () => {
    expect(checkWatermark(addWatermark(base))).toEqual([]);
  });
  it("flags watermark overlapping dialogue time", () => {
    const srt = `1\n00:00:09,000 --> 00:00:11,000\n${W}\n\n2\n00:00:10,000 --> 00:00:12,000\nආයුබෝවන්\n`;
    expect(checkWatermark(srt).map((i) => i.kind)).toEqual(["overlap"]);
  });
  it("flags watermark mixed into a dialogue cue", () => {
    const srt = `1\n00:00:10,000 --> 00:00:12,000\nආයුබෝවන්\n${W}\n`;
    expect(checkWatermark(srt)[0]?.kind).toBe("overlap");
  });
  it("flags a second watermark at the start", () => {
    const srt = `1\n00:00:01,000 --> 00:00:03,000\n${W}\n\n2\n00:00:04,000 --> 00:00:06,000\n${W}\n\n3\n00:00:10,000 --> 00:00:12,000\nආයුබෝවන්\n`;
    expect(checkWatermark(srt)).toEqual([expect.objectContaining({ cue: 2, kind: "duplicate" })]);
  });
  it("fix keeps dialogue and removes duplicates", () => {
    const srt = `1\n00:00:10,000 --> 00:00:12,000\nආයුබෝවන්\n${W}\n\n2\n00:00:13,000 --> 00:00:14,000\n${W}\n`;
    const fixed = addWatermark(srt);
    expect(fixed).toContain("ආයුබෝවන්");
    expect(checkWatermark(fixed)).toEqual([]);
  });
});

import { rankTrending } from "@/lib/engine.server";
describe("rankTrending", () => {
  it("orders by TMDB trending and caps at 10", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ id: 100 + i, tmdb_id: String(i) }));
    const ids = [14, 99, 3, ...Array.from({ length: 12 }, (_, i) => i)];
    const r = rankTrending(ids, rows);
    expect(r.slice(0, 2)).toEqual([114, 103]);
    expect(r).toHaveLength(10);
  });
});
