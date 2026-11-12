import { describe, it, expect } from "vitest";
import { cleanSrt, stripHearingImpaired } from "@/lib/engine.server";

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

describe("cleanSrt — Wyzie free-plan ad", () => {
  const WYZIE = `1
00:00:00,000 --> 00:00:06,000
You're on the free plan. Unlock every source, AI translation & ad-free subs → sub.wyzie.io

2
00:01:07,660 --> 00:01:11,660
I'm free now. You're on the plan, right?
`;
  const { srt, removed } = cleanSrt(WYZIE);
  it("drops the whole ad cue, not just the link", () => {
    expect(removed).toBe(1);
    expect(srt).not.toMatch(/free plan|ad-free|wyzie|→/i);
  });
  it("keeps normal dialogue that uses the same words", () => {
    expect(srt).toBe("1\n00:01:07,660 --> 00:01:11,660\nI'm free now. You're on the plan, right?\n");
  });
});

describe("cleanSrt — hearing-impaired sound tags", () => {
  const SDH = `1
00:00:01,000 --> 00:00:02,000
(gunshot)

2
00:00:03,000 --> 00:00:04,000
[woman screaming]

3
00:00:05,000 --> 00:00:07,000
- (gasps) What was that?
- [door slams] Get down!

4
00:00:08,000 --> 00:00:09,000
JOHN: We need to go.

5
00:00:10,000 --> 00:00:11,000
<i>(GUNSHOTS
CONTINUE)</i>

6
00:00:12,000 --> 00:00:13,000
♪ ♪

7
00:00:14,000 --> 00:00:15,000
- [grunts]
- Run!

8
00:00:16,000 --> 00:00:17,000
Okay: listen to me, Mr. Reese.
`;
  const { srt, removed, soundTags } = cleanSrt(SDH);
  const texts = srt.trim().split("\n\n").map((b) => b.split("\n").slice(2).join("\n"));
  it("drops cues that are only sound descriptions", () => expect(removed).toBe(4));
  it("keeps the spoken words and their timing", () => {
    expect(texts).toEqual(["- What was that?\n- Get down!", "We need to go.", "Run!", "Okay: listen to me, Mr. Reese."]);
    expect(srt).toContain("00:00:05,000 --> 00:00:07,000");
  });
  it("counts cues that had sound tags or speaker labels", () => expect(soundTags).toBe(7));
});

describe("stripHearingImpaired — keeps normal dialogue formatting", () => {
  it("keeps a two-speaker dash line untouched", () => {
    expect(stripHearingImpaired("- Is this your first... - What?")).toBe("- Is this your first... - What?");
  });
  it("keeps ellipsis", () => expect(stripHearingImpaired("(sighs) Well...")).toBe("Well..."));
});
