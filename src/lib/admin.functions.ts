import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const withKey = <T extends z.ZodRawShape>(shape: T) => z.object({ key: z.string().max(500), ...shape });

async function guard(key: string) {
  const e = await import("./engine.server");
  if (!e.checkSecret(key)) throw new Error("Unauthorized: invalid access key");
  return e;
}

export const getEnv = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({}).parse(d))
  .handler(async ({ data }) => (await guard(data.key)).envStatus());

export const getOverview = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({}).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const sb = e.db();
    const counts: Record<string, number> = {};
    await Promise.all(
      e.STATUSES.map(async (s) => {
        const { count } = await sb.from("subtitle_automation_jobs").select("id", { count: "exact", head: true }).eq("status", s);
        counts[s] = count ?? 0;
      }),
    );
    counts["total"] = Object.values(counts).reduce((a, b) => a + b, 0);
    return counts;
  });

export const listJobs = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({ status: z.string().max(30), q: z.string().max(200) }).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    let q = e.db()
      .from("subtitle_automation_jobs")
      .select("id,tmdb_id,media_type,title,season_number,episode_number,release_date,popularity,status,attempts,next_retry_at,error_log,srt_url,updated_at")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (data.status === "needs_review") q = q.eq("status", "failed").like("error_log", "[NEEDS_REVIEW]%");
    else if (data.status === "qa_waiting") q = q.eq("status", "failed").like("error_log", "[QA_WAITING]%");
    else if (data.status === "failed") q = q.eq("status", "failed").or("error_log.is.null,and(error_log.not.like.[NEEDS_REVIEW]%,error_log.not.like.[QA_WAITING]%)");
    else if (data.status !== "all") q = q.eq("status", data.status);
    const t = data.q.trim();
    if (t) q = /^\d+$/.test(t) ? q.eq("tmdb_id", Number(t)) : q.ilike("title", `%${t.replace(/[%,()]/g, "")}%`);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return (rows ?? []).map((row) => {
      if (row.status !== "failed") return row;
      if (row.error_log?.startsWith("[NEEDS_REVIEW]")) return { ...row, status: "needs_review" };
      if (row.error_log?.startsWith("[QA_WAITING]")) return { ...row, status: "qa_waiting" };
      return row;
    });
  });

export const getPreview = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const { data: r } = await e.db().from("subtitle_automation_jobs").select("srt_preview").eq("id", data.id).maybeSingle();
    return r?.srt_preview ?? "";
  });

export const retryJob = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    await e.db().from("subtitle_automation_jobs").update({ status: "waiting_embed", attempts: 0, next_retry_at: null, error_log: null }).eq("id", data.id);
    return true;
  });

export const deleteJob = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const { error } = await e.db().from("subtitle_automation_jobs").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return true;
  });

export const deleteJobs = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({ ids: z.array(z.string().uuid()) }).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    if (!data.ids.length) return true;
    const { error } = await e.db().from("subtitle_automation_jobs").delete().in("id", data.ids);
    if (error) throw new Error(error.message);
    return true;
  });

export const loadSettings = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({}).parse(d))
  .handler(async ({ data }) => (await guard(data.key)).getSettings());

const settingsSchema = z.object({
  minPopularity: z.number().min(0).max(10000),
  minVoteCount: z.number().int().min(0).max(100000),
  minRating: z.number().min(0).max(10),
  minRuntime: z.number().int().min(0).max(600),
  lookaheadDays: z.number().int().min(0).max(365),
  maxBatchSize: z.number().int().min(1).max(50),
  maxScanJobs: z.number().int().min(1).max(100),
  retryHours: z.number().min(0.25).max(720),
  maxAttempts: z.number().int().min(1).max(100),
  embedProbeUrl: z.union([z.literal(""), z.string().url().max(500)]),
  bucket: z.string().min(1).max(63),
  revalidateUrl: z.string().max(500),
  seriesTypeValue: z.string().min(1).max(30),
  myMemoryEmail: z.string().max(200).optional().default(""),
  wyzieApiKey: z.string().max(200).optional().default(""),
  subdlApiKey: z.string().max(200).optional().default(""),
});

export const updateSettings = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({ settings: settingsSchema }).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    await e.saveSettings(data.settings);
    return true;
  });

export const scanNow = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({}).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const logs: string[] = [];
    try {
      const r = await e.runScan((m) => logs.push(m));
      return { ok: true, logs, summary: r };
    } catch (err) {
      return { ok: false, logs: [...logs, (err as Error).message], summary: null };
    }
  });

export const processNow = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({}).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const logs: string[] = [];
    try {
      const r = await e.runProcess((m) => logs.push(m));
      return { ok: true, logs, summary: r };
    } catch (err) {
      return { ok: false, logs: [...logs, (err as Error).message], summary: null };
    }
  });

export const manualProcess = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    withKey({
      tmdbId: z.number().int().positive(),
      mediaType: z.enum(["movie", "tv"]),
      season: z.number().int().min(0).max(500).optional(),
      episode: z.number().int().min(1).max(5000).optional(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const logs: string[] = [];
    try {
      const r = await e.runManual(
        { tmdbId: data.tmdbId, mediaType: data.mediaType, season: data.season, episode: data.episode },
        (m) => { if (!m.startsWith("@@")) logs.push(m); },
      );
      return { ok: r.status === "completed", status: r.status, logs };
    } catch (err) {
      return { ok: false, status: "failed", logs: [...logs, `✗ ${(err as Error).message}`] };
    }
  });

export const tvSeasons = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({ tmdbId: z.number().int().positive() }).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    return e.tvSeasonCounts(data.tmdbId);
  });

export const trackForAutomation = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    withKey({
      tmdbId: z.number().int().positive(),
      mediaType: z.enum(["movie", "tv"]),
      season: z.number().int().min(0).max(500).optional(),
      episodeFrom: z.number().int().min(1).max(5000).optional(),
      episodeTo: z.number().int().min(1).max(5000).optional(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const sb = e.db();
    const d = await e.tmdb(`/${data.mediaType}/${data.tmdbId}`);
    const today = new Date().toISOString().slice(0, 10);
    const nowIso = new Date().toISOString();

    // 1. Fetch any existing automation queue jobs for this TMDB ID
    const { data: existingJobs } = await sb
      .from("subtitle_automation_jobs")
      .select("season_number, episode_number, status")
      .eq("tmdb_id", data.tmdbId)
      .eq("media_type", data.mediaType);

    const existingStatusMap = new Map<string, string>();
    for (const ej of existingJobs ?? []) {
      existingStatusMap.set(`${ej.season_number ?? 0}_${ej.episode_number ?? 0}`, ej.status);
    }

    // 2. Fetch already published Sinhala subtitles directly from OnFlix content/episodes
    const { data: contentRow } = await sb
      .from("content")
      .select("id, sinhala_subtitle_url")
      .eq("tmdb_id", data.tmdbId)
      .maybeSingle();

    const subbedEps = new Set<number>();
    let movieSubbed = false;
    if (contentRow) {
      if (data.mediaType === "movie" && contentRow.sinhala_subtitle_url) {
        movieSubbed = true;
      } else if (data.mediaType === "tv") {
        const { data: eps } = await sb
          .from("episodes")
          .select("episode")
          .eq("content_id", contentRow.id)
          .eq("season", data.season ?? 1)
          .not("sinhala_subtitle_url", "is", null);
        for (const ep of eps ?? []) {
          subbedEps.add(Number(ep.episode));
        }
      }
    }

    const jobs: any[] = [];

    if (data.mediaType === "movie") {
      const releaseDate = d.release_date || null;
      const isUpcoming = Boolean(releaseDate && releaseDate > today);
      const isAlreadyCompleted = existingStatusMap.get("0_0") === "completed" || movieSubbed;
      jobs.push({
        tmdb_id: d.id,
        media_type: "movie",
        title: d.title ?? "Untitled",
        season_number: 0,
        episode_number: 0,
        release_date: releaseDate,
        popularity: d.popularity ?? 0,
        runtime: d.runtime ?? null,
        poster_path: d.poster_path ?? null,
        status: isAlreadyCompleted ? "completed" : (isUpcoming ? "upcoming" : "waiting_embed"),
        attempts: isAlreadyCompleted ? 1 : 0,
        next_retry_at: null,
        updated_at: nowIso,
      });
    } else {
      const seasonNum = data.season ?? 1;
      const se = await e.tmdb(`/tv/${data.tmdbId}/season/${seasonNum}`).catch(() => null);
      const eps: any[] = Array.isArray(se?.episodes) ? se.episodes : [];

      const from = data.episodeFrom ?? (eps.length > 0 ? Number(eps[0].episode_number) : 1);
      const to = data.episodeTo ?? (eps.length > 0 ? Number(eps[eps.length - 1].episode_number) : from);

      for (let epNum = from; epNum <= to; epNum++) {
        const epMeta = eps.find((x) => Number(x.episode_number) === epNum);
        const airDate = epMeta?.air_date || null;
        const isUpcoming = Boolean(airDate && airDate > today);
        const epKey = `${seasonNum}_${epNum}`;
        const existingStatus = existingStatusMap.get(epKey);
        const isAlreadyCompleted = existingStatus === "completed" || subbedEps.has(epNum);

        // Preserve status if currently completed or processing, otherwise assign based on upcoming/embed
        let status = isUpcoming ? "upcoming" : "waiting_embed";
        if (isAlreadyCompleted) {
          status = "completed";
        } else if (existingStatus && existingStatus !== "waiting_embed" && existingStatus !== "upcoming") {
          status = existingStatus;
        }

        jobs.push({
          tmdb_id: d.id,
          media_type: "tv",
          title: `${d.name} S${seasonNum}E${epNum}`,
          season_number: seasonNum,
          episode_number: epNum,
          release_date: airDate,
          popularity: d.popularity ?? 0,
          runtime: epMeta?.runtime ?? null,
          poster_path: se?.poster_path ?? d.poster_path ?? null,
          status,
          attempts: isAlreadyCompleted ? 1 : 0,
          next_retry_at: null,
          updated_at: nowIso,
        });
      }
    }

    let inserted = 0;
    for (const j of jobs) {
      const { error } = await sb
        .from("subtitle_automation_jobs")
        .upsert(j, { onConflict: "tmdb_id,media_type,season_number,episode_number" });
      if (!error) inserted++;
    }

    return {
      ok: true,
      count: inserted,
      firstJob: jobs[0],
      isUpcoming: jobs[0]?.status === "upcoming",
      releaseDate: jobs[0]?.release_date,
    };
  });

export const listUserRequests = createServerFn({ method: "POST" })
  .inputValidator(
    (d) =>
      withKey({
        status: z.string().max(30).optional().default("all"),
        q: z.string().max(200).optional().default(""),
      }).parse(d),
  )
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    let q = e
      .db()
      .from("requests")
      .select("id,title,tmdb_id,type,status,email,created_at,updated_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (data.status && data.status !== "all") {
      q = q.eq("status", data.status);
    }
    const t = data.q.trim();
    if (t) {
      if (/^\d+$/.test(t)) {
        q = q.eq("tmdb_id", Number(t));
      } else {
        const clean = t.replace(/[%,()]/g, "");
        q = q.or(`title.ilike.%${clean}%,email.ilike.%${clean}%`);
      }
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const list = rows ?? [];

    // Enrich with TMDB metadata (poster, year, rating, overview) in parallel
    const enriched = await Promise.all(
      list.map(async (item) => {
        try {
          const det = await e.tmdb(`/${item.type}/${item.tmdb_id}`, {});
          return {
            ...item,
            poster_path: (det?.poster_path as string | null) ?? null,
            release_date: ((det?.release_date || det?.first_air_date) as string | null) ?? null,
            vote_average: (det?.vote_average as number | null) ?? null,
            overview: (det?.overview as string | null) ?? null,
          };
        } catch {
          return item;
        }
      }),
    );
    return enriched;
  });

export const updateUserRequestStatus = createServerFn({ method: "POST" })
  .inputValidator(
    (d) =>
      withKey({
        id: z.union([z.number().int(), z.string()]),
        status: z.enum(["pending", "approved", "completed", "rejected"]),
      }).parse(d),
  )
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const { error } = await e
      .db()
      .from("requests")
      .update({ status: data.status, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return true;
  });

export const deleteUserRequest = createServerFn({ method: "POST" })
  .inputValidator(
    (d) =>
      withKey({
        id: z.union([z.number().int(), z.string()]),
      }).parse(d),
  )
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const { error } = await e.db().from("requests").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return true;
  });

export const getPendingRequestsCount = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({}).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const { count, error } = await e
      .db()
      .from("requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    if (error) return 0;
    return count ?? 0;
  });

export const getAnalyticsData = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({}).parse(d))
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const sb = e.db();

    // 1. Job counts by status
    const counts: Record<string, number> = {};
    await Promise.all(
      e.STATUSES.map(async (s) => {
        const { count } = await sb
          .from("subtitle_automation_jobs")
          .select("id", { count: "exact", head: true })
          .eq("status", s);
        counts[s] = count ?? 0;
      }),
    );
    const totalJobs = Object.values(counts).reduce((a, b) => a + b, 0);
    const completedJobs = counts["completed"] ?? 0;
    const failedJobs = counts["failed"] ?? 0;
    const successRate =
      completedJobs + failedJobs > 0
        ? Math.round((completedJobs / (completedJobs + failedJobs)) * 100)
        : 100;

    // 2. Media split (movies vs tv shows)
    const { count: movieCount } = await sb
      .from("subtitle_automation_jobs")
      .select("id", { count: "exact", head: true })
      .eq("media_type", "movie");
    const { count: tvCount } = await sb
      .from("subtitle_automation_jobs")
      .select("id", { count: "exact", head: true })
      .eq("media_type", "tv");

    // 3. Last 14 days activity trend
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: recentJobs } = await sb
      .from("subtitle_automation_jobs")
      .select("status,created_at,updated_at")
      .gte("updated_at", fourteenDaysAgo)
      .limit(1000);

    const dailyMap: Record<string, { date: string; completed: number; failed: number; total: number }> = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(5, 10); // "MM-DD"
      dailyMap[key] = { date: key, completed: 0, failed: 0, total: 0 };
    }

    for (const j of recentJobs ?? []) {
      const dKey = (j.updated_at || j.created_at || "").slice(5, 10);
      if (dailyMap[dKey]) {
        dailyMap[dKey].total++;
        if (j.status === "completed") dailyMap[dKey].completed++;
        else if (j.status === "failed") dailyMap[dKey].failed++;
      }
    }
    const dailyActivity = Object.values(dailyMap);

    // 4. User requests summary & top requests
    const { data: reqs } = await sb.from("requests").select("id,title,type,status,created_at").limit(200);
    const reqCounts = {
      total: reqs?.length ?? 0,
      pending: reqs?.filter((r) => r.status === "pending").length ?? 0,
      completed: reqs?.filter((r) => r.status === "completed").length ?? 0,
      rejected: reqs?.filter((r) => r.status === "rejected").length ?? 0,
    };

    const titleFreq: Record<string, { title: string; count: number; type: string }> = {};
    for (const r of reqs ?? []) {
      const t = (r.title ?? "").trim();
      if (!t) continue;
      const key = `${r.type}:${t.toLowerCase()}`;
      if (!titleFreq[key]) {
        titleFreq[key] = { title: t, count: 0, type: r.type };
      }
      titleFreq[key].count++;
    }
    const topRequests = Object.values(titleFreq)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    // 5. Engine & API Key health
    const { geminiKeys } = await import("./gemini-polish.server");
    const gKeys = geminiKeys();
    const sKeys = e.subdlKeys();

    return {
      counts,
      totalJobs,
      completedJobs,
      failedJobs,
      successRate,
      mediaSplit: {
        movies: movieCount ?? 0,
        tvShows: tvCount ?? 0,
      },
      dailyActivity,
      requestsSummary: {
        ...reqCounts,
        topRequests,
      },
      engineStatus: {
        geminiKeysCount: gKeys.length,
        subdlKeysCount: sKeys.length,
        workerCapacity: Math.min(Math.max(gKeys.length * 3, 5), 15),
      },
    };
  });

export const listEditableSubtitles = createServerFn({ method: "POST" })
  .inputValidator(
    (d) =>
      withKey({
        q: z.string().max(200).optional().default(""),
      }).parse(d),
  )
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    let q = e
      .db()
      .from("subtitle_automation_jobs")
      .select("id,tmdb_id,media_type,title,season_number,episode_number,status,srt_url,updated_at")
      .not("srt_preview", "is", null)
      .order("updated_at", { ascending: false })
      .limit(60);

    const term = data.q.trim();
    if (term) {
      if (/^\d+$/.test(term)) {
        q = q.eq("tmdb_id", Number(term));
      } else {
        q = q.ilike("title", `%${term.replace(/[%,()]/g, "")}%`);
      }
    }

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getSubtitleForEdit = createServerFn({ method: "POST" })
  .inputValidator(
    (d) =>
      withKey({
        jobId: z.string().uuid().optional(),
        tmdbId: z.number().int().positive().optional(),
        mediaType: z.enum(["movie", "tv"]).optional(),
        season: z.number().int().min(0).max(500).optional(),
        episode: z.number().int().min(1).max(5000).optional(),
      }).parse(d),
  )
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const sb = e.db();
    const s = await e.getSettings();

    let job: any = null;
    if (data.jobId) {
      const { data: row } = await sb
        .from("subtitle_automation_jobs")
        .select("id,tmdb_id,media_type,title,season_number,episode_number,status,srt_path,srt_url,srt_preview")
        .eq("id", data.jobId)
        .maybeSingle();
      job = row;
    } else if (data.tmdbId && data.mediaType) {
      let q = sb
        .from("subtitle_automation_jobs")
        .select("id,tmdb_id,media_type,title,season_number,episode_number,status,srt_path,srt_url,srt_preview")
        .eq("tmdb_id", data.tmdbId)
        .eq("media_type", data.mediaType)
        .order("updated_at", { ascending: false });
      if (data.mediaType === "tv" && data.season !== undefined && data.episode !== undefined) {
        q = q.eq("season_number", data.season).eq("episode_number", data.episode);
      }
      const { data: rows } = await q.limit(1);
      job = rows?.[0] ?? null;
    }

    if (!job) {
      throw new Error("No subtitle job found matching the given parameters.");
    }

    let srtContent = "";

    // Try downloading from Supabase storage if srt_path exists
    if (job.srt_path) {
      try {
        const dl = await sb.storage.from(s.bucket).download(job.srt_path);
        if (dl.data) {
          srtContent = await dl.data.text();
        }
      } catch {
        // fallback
      }
    }

    // If still empty and srt_url exists, try fetching via HTTP
    if (!srtContent && job.srt_url) {
      try {
        const res = await fetch(job.srt_url);
        if (res.ok) {
          srtContent = await res.text();
        }
      } catch {
        // fallback
      }
    }

    // Fallback to preview if storage download was not available
    if (!srtContent && job.srt_preview) {
      srtContent = job.srt_preview;
    }

    return {
      id: job.id as string,
      title: (job.title as string) || "Untitled",
      tmdbId: job.tmdb_id as number,
      mediaType: job.media_type as "movie" | "tv",
      seasonNumber: (job.season_number as number | null) ?? null,
      episodeNumber: (job.episode_number as number | null) ?? null,
      status: (job.status as string) || "completed",
      srtUrl: (job.srt_url as string | null) ?? null,
      srtContent,
    };
  });

export const saveEditedSubtitle = createServerFn({ method: "POST" })
  .inputValidator(
    (d) =>
      withKey({
        jobId: z.string().uuid(),
        srtContent: z.string().min(10).max(10000000), // up to 10MB
      }).parse(d),
  )
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const sb = e.db();
    const s = await e.getSettings();

    const { data: job, error: jobErr } = await sb
      .from("subtitle_automation_jobs")
      .select("id,tmdb_id,media_type,title,season_number,episode_number,status,srt_path")
      .eq("id", data.jobId)
      .single();

    if (jobErr || !job) {
      throw new Error("Job not found");
    }

    const path =
      job.srt_path ||
      `subtitles/${job.media_type}/${job.tmdb_id}${
        job.media_type === "tv" ? `_s${job.season_number}_e${job.episode_number}` : ""
      }_si.srt`;

    // Upload updated SRT to Supabase storage
    const up = await sb.storage
      .from(s.bucket)
      .upload(path, new Blob([e.sanitizeSinhalaSrt(data.srtContent)], { type: "application/x-subrip" }), {
        upsert: true,
        contentType: "application/x-subrip",
      });

    if (up.error) {
      throw new Error(`Failed to upload subtitle to storage: ${up.error.message}`);
    }

    const url = sb.storage.from(s.bucket).getPublicUrl(path).data.publicUrl;
    const now = new Date().toISOString();

    // Update job record
    await sb
      .from("subtitle_automation_jobs")
      .update({
        srt_path: path,
        srt_url: url,
        srt_preview: data.srtContent.slice(0, 4000),
        updated_at: now,
      })
      .eq("id", job.id);

    // If job was already published / completed, update content or episodes in OnFlix DB
    if (job.status === "completed") {
      if (job.media_type === "movie") {
        await sb
          .from("content")
          .update({ sinhala_subtitle_url: url, updated_at: now })
          .eq("tmdb_id", job.tmdb_id);
      } else {
        const { data: tvContent } = await sb
          .from("content")
          .select("id")
          .eq("tmdb_id", job.tmdb_id)
          .maybeSingle();
        if (tvContent?.id) {
          await sb
            .from("episodes")
            .update({ sinhala_subtitle_url: url, updated_at: now })
            .eq("content_id", tvContent.id)
            .eq("season", job.season_number)
            .eq("episode", job.episode_number);
        }
      }
    }

    return { ok: true, url };
  });

export const getTmdbConfig = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({}).parse(d))
  .handler(async ({ data }) => {
    await guard(data.key);
    return {
      apiKey: process.env["TMDB_API_KEY"] || "32338871e211188ebf5597d6a3fe0bc5",
    };
  });

export const searchTmdbTitles = createServerFn({ method: "POST" })
  .inputValidator(
    (d) =>
      withKey({
        query: z.string().max(200).optional().default(""),
        mediaType: z.enum(["all", "movie", "tv"]).optional().default("all"),
        page: z.number().int().min(1).max(10).optional().default(1),
        filter: z.enum(["search", "trending", "upcoming", "top_rated"]).optional().default("search"),
        language: z.string().max(10).optional().default("all"),
        genre: z.string().max(20).optional().default("all"),
        country: z.string().max(10).optional().default("all"),
        year: z.string().max(10).optional().default("all"),
      }).parse(d),
  )
  .handler(async ({ data }) => {
    const e = await guard(data.key);
    const q = data.query.trim();

    const GENRE_MOVIE: Record<string, number> = {
      action: 28, animation: 16, comedy: 35, crime: 80, documentary: 99,
      drama: 18, family: 10751, fantasy: 878, horror: 27, mystery: 9648,
      romance: 10749, thriller: 53,
    };
    const GENRE_TV: Record<string, number> = {
      action: 10759, animation: 16, comedy: 35, crime: 80, documentary: 99,
      drama: 18, family: 10751, fantasy: 10765, horror: 9648, mystery: 9648,
      romance: 10749, thriller: 9648,
    };

    let endpoint = "/search/multi";
    const params: Record<string, string> = { page: String(data.page) };

    const hasFilters = (data.language && data.language !== "all") ||
      (data.genre && data.genre !== "all") ||
      (data.country && data.country !== "all") ||
      (data.year && data.year !== "all");

    if (q) {
      if (data.mediaType === "movie") {
        endpoint = "/search/movie";
      } else if (data.mediaType === "tv") {
        endpoint = "/search/tv";
      } else {
        endpoint = "/search/multi";
      }
      params["query"] = q;
    } else if (data.filter === "top_rated" || hasFilters) {
      // Use Discover API for precise filtering by language, genre, country, year and top rating
      const type = data.mediaType === "tv" ? "tv" : "movie";
      endpoint = `/discover/${type}`;
      params["sort_by"] = "vote_average.desc";
      params["vote_count.gte"] = type === "tv" ? "80" : "150";

      if (data.language && data.language !== "all") {
        params["with_original_language"] = data.language;
      }
      if (data.country && data.country !== "all") {
        params["with_origin_country"] = data.country;
      }
      if (data.year && data.year !== "all") {
        if (type === "tv") {
          params["first_air_date_year"] = data.year;
        } else {
          params["primary_release_year"] = data.year;
        }
      }
      if (data.genre && data.genre !== "all") {
        const gid = type === "tv" ? GENRE_TV[data.genre] : GENRE_MOVIE[data.genre];
        if (gid) params["with_genres"] = String(gid);
      }
    } else {
      if (data.filter === "trending") {
        endpoint = data.mediaType === "all" ? "/trending/all/day" : `/trending/${data.mediaType}/day`;
      } else if (data.filter === "upcoming") {
        endpoint = "/movie/upcoming";
      } else {
        endpoint = "/trending/all/day";
      }
    }

    try {
      const res = await e.tmdb(endpoint, params);
      const results: any[] = res?.results ?? [];

      return results
        .filter((item: any) => {
          if (!item.id) return false;
          const type = item.media_type || (item.title ? "movie" : "tv");
          return type === "movie" || type === "tv";
        })
        .map((item: any) => {
          const type = item.media_type || (item.title ? "movie" : "tv");
          const title = item.title || item.name || "Untitled";
          const date = item.release_date || item.first_air_date || null;
          const year = date ? date.slice(0, 4) : null;
          const poster = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
          const backdrop = item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : null;

          return {
            id: item.id as number,
            title,
            mediaType: type as "movie" | "tv",
            releaseDate: date,
            year,
            voteAverage: typeof item.vote_average === "number" ? Math.round(item.vote_average * 10) / 10 : 0,
            voteCount: item.vote_count || 0,
            overview: item.overview || "",
            posterUrl: poster,
            backdropUrl: backdrop,
            popularity: item.popularity || 0,
          };
        });
    } catch (err) {
      throw new Error(`TMDB error: ${(err as Error).message}`);
    }
  });

export const getApiKeysHealthReport = createServerFn({ method: "POST" })
  .inputValidator((d) => withKey({}).parse(d))
  .handler(async ({ data }) => {
    await guard(data.key);
    const { runApiKeysHealthAudit } = await import("./key-health.server");
    return runApiKeysHealthAudit();
  });


