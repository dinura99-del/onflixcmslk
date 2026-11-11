import { describe, it, expect } from "vitest";
import { claimQueueJob, isBlockedByPrevious, prioritizeQueueJobs } from "@/lib/engine.server";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("sequential episode gate", () => {
  it("blocks when previous episode is queued but not completed", () => {
    expect(isBlockedByPrevious("processing", false)).toBe(true);
    expect(isBlockedByPrevious("waiting_embed", false)).toBe(true);
  });
  it("allows when previous episode is already published", () => {
    expect(isBlockedByPrevious("processing", true)).toBe(false);
  });
  it("allows when previous episode job is completed", () => {
    expect(isBlockedByPrevious("completed", false)).toBe(false);
  });
  it("allows when previous episode was never queued", () => {
    expect(isBlockedByPrevious(null, false)).toBe(false);
  });
});

describe("database queue job lock", () => {
  it("allows only one concurrent processor to claim a job", async () => {
    let row: { id: string; status: string; attempts: number } = { id: "job-1", status: "waiting_embed", attempts: 0 };
    const sb = {
      from: () => {
        let patch: Record<string, unknown> = {};
        let filters: Record<string, unknown> = {};
        const query = {
          update: (value: Record<string, unknown>) => { patch = value; return query; },
          eq: (column: string, value: unknown) => { filters[column] = value; return query; },
          select: () => query,
          maybeSingle: async () => {
            if (filters["id"] !== row["id"] || filters["status"] !== row["status"]) return { data: null, error: null };
            row = { ...row, ...patch } as typeof row;
            return { data: { ...row }, error: null };
          },
        };
        return query;
      },
    } as unknown as SupabaseClient;
    const candidate = { id: "job-1", status: "waiting_embed", attempts: 0 };

    const claims = await Promise.all([claimQueueJob(sb, candidate), claimQueueJob(sb, candidate)]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    expect(row).toMatchObject({ status: "processing", attempts: 1 });
  });

  it("does not claim a job already marked processing", async () => {
    const sb = { from: () => { throw new Error("must not touch database"); } } as unknown as SupabaseClient;
    await expect(claimQueueJob(sb, { id: "job-1", status: "processing", attempts: 1 })).resolves.toBeNull();
  });
});

describe("queue job priority", () => {
  it("processes older eligible jobs before new zero-attempt jobs", () => {
    const jobs = prioritizeQueueJobs([
      { id: "new", created_at: "2026-11-08T12:00:00.000Z", attempts: 0, popularity: 100 },
      { id: "old-retry", created_at: "2026-11-07T12:00:00.000Z", attempts: 4, popularity: 2 },
      { id: "old-fresh", created_at: "2026-11-07T12:00:00.000Z", attempts: 0, popularity: 1 },
    ]);

    expect(jobs.map((job) => job.id)).toEqual(["old-fresh", "old-retry", "new"]);
  });
});
