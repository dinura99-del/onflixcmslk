import { describe, it, expect } from "vitest";
import { subdlKeys } from "./engine.server";

describe("subdlKeys", () => {
  it("collects SUBDL_API_KEY plus numbered keys in order", () => {
    expect(subdlKeys({}, { SUBDL_API_KEY: "a", SUBDL_API_KEY_2: "c", SUBDL_API_KEY_1: "b", SUBDL_API_KEY_03: "d" })).toEqual(["a", "b", "c", "d"]);
  });
  it("splits comma-separated and dedupes", () => {
    expect(subdlKeys({}, { SUBDL_API_KEY: "a, b", SUBDL_API_KEY_1: "a" })).toEqual(["a", "b"]);
  });
});
