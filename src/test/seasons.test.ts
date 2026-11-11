import { describe, it, expect } from "vitest";
import { mergeSeason, DEFAULT_SETTINGS } from "@/lib/engine.server";

describe("content.seasons", () => {
  it("adds a new season in the CMS format", () => {
    expect(mergeSeason(null, 2)).toEqual([{ season_number: 2, season_name: "Season 2", episodes: [] }]);
  });
  it("keeps seasons sorted ascending", () => {
    const r = mergeSeason([{ season_number: 3, season_name: "Season 3", episodes: [] }], 1);
    expect(r.map((x) => x.season_number)).toEqual([1, 3]);
  });
  it("does not duplicate an existing season", () => {
    expect(mergeSeason([{ season_number: 2, season_name: "Season 2", episodes: [{ x: 1 }] }], 2)).toHaveLength(1);
  });
  it("merges episode details into season.episodes", () => {
    const res = mergeSeason(null, 1, {
      episode_number: 1,
      title: "Pilot",
      embed_link: "https://embed.test/1",
      sinhala_subtitle_url: "https://sub.test/1.srt",
    });
    expect(res).toHaveLength(1);
    expect(res[0].season_number).toBe(1);
    expect(res[0].episodes).toHaveLength(1);
    expect(res[0].episodes[0].episode_number).toBe(1);
    expect(res[0].episodes[0].title).toBe("Pilot");
    expect(res[0].episodes[0].embed_link).toBe("https://embed.test/1");
    expect(res[0].episodes[0].sinhala_subtitle_url).toBe("https://sub.test/1.srt");
    expect(res[0].episodes[0].status).toBe("published");
  });
  it("updates existing episode without duplicating", () => {
    const initial = mergeSeason(null, 1, {
      episode_number: 1,
      title: "Pilot",
    });
    const updated = mergeSeason(initial, 1, {
      episode_number: 1,
      title: "Pilot (Updated)",
      embed_link: "https://embed.test/1",
    });
    expect(updated[0].episodes).toHaveLength(1);
    expect(updated[0].episodes[0].title).toBe("Pilot (Updated)");
    expect(updated[0].episodes[0].embed_link).toBe("https://embed.test/1");
  });
  it("series type defaults to tv_show", () => {
    expect(DEFAULT_SETTINGS.seriesTypeValue).toBe("tv_show");
  });
});

import { passesQuality } from "@/lib/engine.server";
describe("scanner quality filter", () => {
  const s = { minPopularity: 20, minVoteCount: 5, minRating: 5.0 };
  it("skips titles rated below 5.0", () => {
    expect(passesQuality({ popularity: 50, vote_count: 100, vote_average: 4.9 }, s)).toBe(false);
  });
  it("keeps titles rated 5.0 or higher", () => {
    expect(passesQuality({ popularity: 50, vote_count: 100, vote_average: 5.0 }, s)).toBe(true);
  });
  it("defaults min rating to 7.0", () => {
    expect(DEFAULT_SETTINGS.minRating).toBe(7.0);
  });
});

import { releasedCounts } from "@/lib/engine.server";
describe("released episode counts", () => {
  it("counts only aired episodes in the current season", () => {
    const d = { last_episode_to_air: { season_number: 2, episode_number: 4 },
      seasons: [{ season_number: 1, episode_count: 8 }, { season_number: 2, episode_count: 10 }, { season_number: 3, episode_count: 6 }] };
    expect(releasedCounts(d)).toEqual({ 1: 8, 2: 4, 3: 0 });
  });
});
