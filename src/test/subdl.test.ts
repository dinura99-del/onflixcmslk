import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { matchesEpisode, srtFromZip } from "@/lib/engine.server";

const j = { media_type: "tv", season_number: 2, episode_number: 5 };
describe("SubDL helpers", () => {
  it("matches episode file names", () => {
    expect(matchesEpisode("Show.S02E05.720p.srt", j)).toBe(true);
    expect(matchesEpisode("Show.S02E15.srt", j)).toBe(false);
  });
  it("extracts the right srt from zip", () => {
    const z = zipSync({ "a.S02E04.srt": strToU8("x"), "a.S02E05.srt": strToU8("1\n00:00 --> 00:01\nhi") });
    expect(srtFromZip(z, j)).toContain("hi");
  });
});
