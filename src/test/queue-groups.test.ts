import { describe, expect, it } from "vitest";
import { groupQueueSeasons } from "@/lib/queue-groups";

const episode = (id: string, season: number, status = "completed", media_type = "tv") => ({
  id, tmdb_id: 5920, media_type, title: `The Mentalist S${season}E${id}`,
  season_number: season, episode_number: Number(id), status,
});

describe("Live Queue season folding", () => {
  it("collapses a season only when all its queued episodes are completed", () => {
    const groups = groupQueueSeasons([episode("1", 4), episode("2", 4)], true);
    expect(groups[0]?.defaultCollapsed).toBe(true);
    expect(groups[0]?.rows.map((row) => row.id)).toEqual(["1", "2"]);
  });
  it("keeps unfinished seasons open", () => {
    const groups = groupQueueSeasons([episode("1", 4), episode("2", 4, "processing")], true);
    expect(groups[0]?.defaultCollapsed).toBe(false);
  });
  it("keeps each season separate", () => {
    const groups = groupQueueSeasons([episode("1", 4), episode("2", 5, "failed")], true);
    expect(groups.map((group) => group.defaultCollapsed)).toEqual([true, false]);
  });
  it("does not infer completion from a filtered list", () => {
    expect(groupQueueSeasons([episode("1", 4)], false)[0]?.defaultCollapsed).toBe(false);
  });
  it("never collapses movies", () => {
    expect(groupQueueSeasons([episode("1", 0, "completed", "movie")], true)[0]?.defaultCollapsed).toBe(false);
  });
});