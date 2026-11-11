import { describe, it, expect } from "vitest";
import { countSources, embedUrl, probeEmbed } from "@/lib/engine.server";

describe("EmbedMaster", () => {
  it("counts premium sources", () => {
    expect(countSources({ ok: true, item: { sources_count: 0, premium_sources_count: 3 } }).total).toBe(3);
  });
  it("uses official endpoints by default", () => {
    expect(embedUrl({ embedProbeUrl: "" }, { media_type: "tv", tmdb_id: 5, season_number: 1, episode_number: 2 }))
      .toBe("https://embedmaster.com/json/tv/check/5/1/2");
  });
  it("live: King's Warden 1321179 is available", async () => {
    const logs: string[] = [];
    expect(await probeEmbed({ embedProbeUrl: "" }, { media_type: "movie", tmdb_id: 1321179 }, (m) => logs.push(m))).toBe(true);
    console.log(logs);
  }, 20000);
});

import { buildEmbedLink } from "@/lib/engine.server";
describe("embed_link", () => {
  it("movie", () => expect(buildEmbedLink({ media_type: "movie", tmdb_id: 550 })).toBe("https://embedmaster.link/movie/550"));
  it("tv", () => expect(buildEmbedLink({ media_type: "tv", tmdb_id: 1399, season_number: 2, episode_number: 3 })).toBe("https://embedmaster.link/tv/1399/2/3"));
});
