import { describe, it, expect } from "vitest";
import { parseSrt, stringifySrt, shiftCues, replaceTextInCues, timeStringToMs, msToTimeString } from "../lib/srt-utils";

describe("srt-utils", () => {
  it("converts timestamps to and from milliseconds", () => {
    const ts = "01:02:03,456";
    const ms = timeStringToMs(ts);
    expect(ms).toBe(1 * 3600000 + 2 * 60000 + 3 * 1000 + 456);
    expect(msToTimeString(ms)).toBe(ts);
  });

  it("parses valid SRT and stringifies back accurately", () => {
    const raw = `1
00:00:01,000 --> 00:00:03,500
ආයුබෝවන්

2
00:00:04,000 --> 00:00:06,000
සුබ දවසක්`;

    const cues = parseSrt(raw);
    expect(cues.length).toBe(2);
    expect(cues[0]?.text).toBe("ආයුබෝවන්");
    expect(cues[0]?.startMs).toBe(1000);
    expect(cues[0]?.endMs).toBe(3500);

    const stringified = stringifySrt(cues);
    expect(stringified).toContain("00:00:01,000 --> 00:00:03,500");
    expect(stringified).toContain("ආයුබෝවන්");
  });

  it("shifts cues accurately forward and backward", () => {
    const raw = `1
00:00:05,000 --> 00:00:08,000
පළමු පේළිය`;

    const cues = parseSrt(raw);
    // Shift forward by 1.5 seconds (+1500ms)
    const forward = shiftCues(cues, 1500);
    expect(forward[0]?.startTime).toBe("00:00:06,500");
    expect(forward[0]?.endTime).toBe("00:00:09,500");

    // Shift backward by 2 seconds (-2000ms)
    const backward = shiftCues(cues, -2000);
    expect(backward[0]?.startTime).toBe("00:00:03,000");
    expect(backward[0]?.endTime).toBe("00:00:06,000");

    // Shift backward exceeding 0 (should clamp to 0)
    const clamped = shiftCues(cues, -10000);
    expect(clamped[0]?.startMs).toBe(0);
    expect(clamped[0]?.startTime).toBe("00:00:00,000");
    expect(clamped[0]?.endMs).toBe(3000); // preserves 3-second duration
  });

  it("replaces words in cues correctly", () => {
    const raw = `1
00:00:01,000 --> 00:00:03,000
මම ජෝන්. ඔව් ජෝන්.`;

    const cues = parseSrt(raw);
    const { cues: updated, count } = replaceTextInCues(cues, "ජෝන්", "පීටර්");
    expect(count).toBe(2);
    expect(updated[0]?.text).toBe("මම පීටර්. ඔව් පීටර්.");
  });
});
