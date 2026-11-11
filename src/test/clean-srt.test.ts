import { describe, it, expect } from "vitest";
import { cleanSrt } from "@/lib/engine.server";

const SRT = `1
00:00:01,000 --> 00:00:03,000
Subtitles by explosiveskull
www.OpenSubtitles.org

2
00:00:04,000 --> 00:00:06,000
Where are you going?

3
00:00:07,000 --> 00:00:09,000
Advertise your product or brand here
contact www.OpenSubtitles.org today

4
00:00:10,000 --> 00:00:12,000
Home. Downloaded from YTS.MX

5
00:00:13,000 --> 00:00:15,000
I'll call you at https://example.com later.
`;

describe("cleanSrt", () => {
  const { srt, removed } = cleanSrt(SRT);
  it("drops promo-only cues", () => expect(removed).toBe(2));
  it("re-indexes remaining cues from 1", () => {
    expect(srt.split("\n\n").map((b) => b.split("\n")[0])).toEqual(["1", "2", "3"]);
  });
  it("removes URLs, domains and promo phrases", () => {
    expect(srt).not.toMatch(/opensubtitles|yts|https?:|www\.|Downloaded from|Subtitles by|Advertise/i);
  });
  it("keeps dialogue", () => {
    expect(srt).toContain("Where are you going?");
    expect(srt).toContain("00:00:13,000 --> 00:00:15,000");
  });
});
