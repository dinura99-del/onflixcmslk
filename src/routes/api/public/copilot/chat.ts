import { createFileRoute } from "@tanstack/react-router";
import { buildCopilotSystemPrompt } from "@/lib/ai-prompts";
import { z } from "zod";

// ─── Message schema ───────────────────────────────────────────────────────────
const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().max(32_000),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

const SelectedCollectionOptionSchema = z.object({
  id: z.string().max(160),
  name: z.string().min(1).max(120),
  description: z.string().max(500),
  tmdb_collection_id: z.number().int().positive().nullable(),
  items: z.array(z.object({
    id: z.number().int().positive(),
    tmdb_id: z.number(),
    title: z.string(),
    type: z.string(),
  })).min(1).max(30),
});

const Body = z.object({
  key: z.string().max(500),
  messages: z.array(MessageSchema).min(1).max(100),
  selected_collection_option: SelectedCollectionOptionSchema.optional(),
});

// ─── Tool definitions sent to Groq ───────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_content",
      description: "Search OnFlix content library by title. Returns up to 12 matching items with their id, title, type, featured status, and rating.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Title search query" },
          content_type: { type: "string", enum: ["movie", "tv_show", "any"], description: "Filter by content type" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_top_ten",
      description: "Get the current Top 10 movies and Top 10 TV shows as displayed on the OnFlix homepage.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_top_ten",
      description: "Update the Top 10 list for movies or TV shows. Provide an ordered array of content IDs (position 0 = rank 1). After updating, the OnFlix web is revalidated automatically.",
      parameters: {
        type: "object",
        properties: {
          content_type: { type: "string", enum: ["movie", "tv_show"], description: "Which Top 10 list to update" },
          content_ids: { type: "array", items: { type: "number" }, description: "Ordered array of OnFlix content IDs (max 10)", maxItems: 10 },
        },
        required: ["content_type", "content_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_featured",
      description: "Get all content currently featured in the OnFlix hero slider.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_featured",
      description: "Add or remove a content item from the hero slider. Revalidates OnFlix web automatically.",
      parameters: {
        type: "object",
        properties: {
          content_id: { type: "number", description: "OnFlix content ID" },
          featured: { type: "boolean", description: "true to add to slider, false to remove" },
        },
        required: ["content_id", "featured"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_content_status",
      description: "Change the publication status of a title to 'published', 'draft', or 'archived'. Setting to 'draft' or 'archived' unpublishes/hides the title from the website. Automatically revalidates OnFlix web.",
      parameters: {
        type: "object",
        properties: {
          content_id: { type: "number", description: "OnFlix content ID" },
          status: { type: "string", enum: ["published", "draft", "archived"], description: "New status: published, draft (unpublished/hidden), or archived" },
        },
        required: ["content_id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_content",
      description: "Permanently delete a content item from the database. Revalidates OnFlix web automatically.",
      parameters: {
        type: "object",
        properties: {
          content_id: { type: "number", description: "OnFlix content ID to delete" },
        },
        required: ["content_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_job_stats",
      description: "Get subtitle automation job statistics: counts by status (upcoming, processing, completed, failed, etc.).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pending_requests",
      description: "Get user title requests that are pending processing. Shows what users want subtitled next.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_user_request_status",
      description: "Update the status of a user title request to 'pending', 'approved', 'completed', or 'rejected'.",
      parameters: {
        type: "object",
        properties: {
          request_id: { type: "number", description: "Request ID" },
          status: { type: "string", enum: ["pending", "approved", "completed", "rejected"], description: "New request status" },
        },
        required: ["request_id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_tmdb",
      description: "Look up movie/TV details on TMDB (The Movie Database) by title or numeric TMDB ID.",
      parameters: {
        type: "object",
        properties: {
          query_or_id: { type: "string", description: "Movie/TV title or numeric TMDB ID" },
          media_type: { type: "string", enum: ["movie", "tv", "any"], description: "Filter by movie or tv" },
        },
        required: ["query_or_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_title",
      description: "Add a new movie or TV show to the automation queue to translate and upload to OnFlix using its TMDB ID.",
      parameters: {
        type: "object",
        properties: {
          tmdb_id: { type: "number", description: "TMDB ID of the title" },
          media_type: { type: "string", enum: ["movie", "tv"], description: "movie or tv. Defaults to 'movie' if unspecified" },
          season: { type: "number", description: "Season number (for TV shows, e.g. 1)" },
          episode: { type: "number", description: "Episode number (for TV shows, e.g. 1)" },
        },
        required: ["tmdb_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "auto_curate_top_ten",
      description: "Automatically curate and rank the Top 10 list for movies or TV shows based on highest rating or latest releases. Automatically revalidates OnFlix web.",
      parameters: {
        type: "object",
        properties: {
          content_type: { type: "string", enum: ["movie", "tv_show"], description: "movie or tv_show" },
          criteria: { type: "string", enum: ["rating", "latest"], description: "ranking criteria" },
        },
        required: ["content_type", "criteria"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "auto_curate_hero_slider",
      description: "Automatically pick and feature the best titles for the homepage Hero Slider based on highest rating or latest releases. STRICT RULE: maximum 7 to 8 items allowed (never exceed 8). Automatically revalidates OnFlix web.",
      parameters: {
        type: "object",
        properties: {
          criteria: { type: "string", enum: ["rating", "latest"], description: "criteria to select featured titles (prefer 'rating')" },
          count: { type: "number", description: "Number of titles to feature (default 8, maximum 8)" },
        },
        required: ["criteria"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_embed_health",
      description: "Verify video stream availability on EmbedMaster for Top 10, Hero Slider, or a specific title.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["top_ten", "featured", "specific"], description: "which content group to check" },
          content_id: { type: "number", description: "content ID if target is 'specific'" },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "auto_fulfill_requests",
      description: "Batch fulfill pending user requests: pulls TMDB metadata, queues automation jobs, and approves requests.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max requests to fulfill (default 5, max 15)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_health_report",
      description: "Comprehensive health report of OnFlix: published content, missing subtitles, automation status, and pending user requests.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_missing_subtitles",
      description: "List published movies or TV shows that lack Sinhala subtitles on OnFlix. Movies have their subtitle on content.sinhala_subtitle_url. TV Shows store subtitles per-episode in the episodes table for released episodes only. Supports content_type filter: 'movie' (for films), 'tv_show', or 'all'.",
      parameters: {
        type: "object",
        properties: {
          content_type: { type: "string", enum: ["movie", "tv_show", "all"], description: "Filter by content type ('movie' for films, 'tv_show' for series, or 'all'). Defaults to 'movie' if user asks about films or movies." },
          limit: { type: "number", description: "Max titles to list (default 20)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_missing_subtitles",
      description: "Automatically queue all published movies/shows that lack Sinhala subtitles into the subtitle automation queue.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max titles to queue (default 5)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_announcement",
      description: "View, update, or disable the sitewide announcement banner on the OnFlix web homepage.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "set", "disable"], description: "action to perform" },
          message: { type: "string", description: "Announcement text (required for 'set')" },
          type: { type: "string", enum: ["info", "warning", "alert"], description: "banner style" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_glossary",
      description: "View or manage custom Sinhala subtitle glossary terms (e.g. character names, slang, terminology) used during translation.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "remove"], description: "list, add, or remove" },
          english: { type: "string", description: "English word or phrase" },
          sinhala: { type: "string", description: "Sinhala translation (required for 'add')" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_collection",
      description: "List, create, update, and curate OnFlix collections. Add only published OnFlix content using its internal content ID, never a TMDB ID.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "create", "update", "add_items", "remove_items"] },
          collection_id: { type: "number", description: "OnFlix collection ID" },
          name: { type: "string", description: "Collection name" },
          description: { type: "string", description: "Short collection description" },
          is_public: { type: "boolean", description: "Whether the collection is visible on OnFlix" },
          poster_url: { type: "string", description: "Optional collection poster URL" },
          backdrop_url: { type: "string", description: "Optional collection backdrop URL" },
          content_ids: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 50, description: "Published OnFlix content IDs to add or remove" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_collection_catalog",
      description: "Inspect published OnFlix movies and TV shows, including genres, years, and ratings, to find collection themes that actually fit the local library.",
      parameters: {
        type: "object",
        properties: {
          content_type: { type: "string", enum: ["both", "movie", "tv_show"], description: "Which published content types to inspect" },
          limit_per_type: { type: "number", description: "Published candidates per type, maximum 20" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the public web for current film/TV collection themes and supporting references. Requires the server-side TAVILY_API_KEY.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Specific public-web search query" },
          max_results: { type: "number", description: "Maximum result count, 3-6" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_tmdb_collections",
      description: "Search real TMDB movie collections by theme and return collection metadata, artwork paths, and matching published OnFlix films. TMDB collections contain movies, not TV shows.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A film-franchise or collection theme to search on TMDB" },
          max_results: { type: "number", description: "Maximum collections to inspect, 1-5" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present_collection_options",
      description: "Present 3-5 final collection options as selectable UI cards after checking the OnFlix catalog and public-web sources. Each option must contain only verified published OnFlix content IDs. Call this after research; wait for the user to select a card before creating anything.",
      parameters: {
        type: "object",
        properties: {
          options: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Collection card title" },
                description: { type: "string", description: "Short user-facing description" },
                tmdb_collection_id: { type: "number", description: "Optional real TMDB movie collection ID for collection-level artwork" },
                content_ids: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 30, description: "Published OnFlix internal content IDs" },
                source_urls: { type: "array", items: { type: "string" }, maxItems: 4, description: "URLs from successful public web search results that support the collection idea" },
              },
              required: ["name", "description", "content_ids", "source_urls"],
            },
          },
        },
        required: ["options"],
      },
    },
  },
] as const;

// ─── Tool executor ────────────────────────────────────────────────────────────
async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { db, getSettings, revalidateOnflixWeb } = await import("@/lib/engine.server");
  const sb = db();

  if (name === "search_content") {
    const q = String(args["query"] ?? "").trim();
    const ct = args["content_type"] as string | undefined;
    let query = sb.from("content")
      .select("id, title, type, tmdb_id, featured, status, rating");
    if (/^\d+$/.test(q)) {
      query = query.or(`tmdb_id.eq.${q},id.eq.${q},title.ilike.%${q}%`);
    } else {
      query = query.ilike("title", `%${q}%`);
    }
    if (ct && ct !== "any") query = query.eq("type", ct);
    const { data, error } = await query.limit(8);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  if (name === "get_top_ten") {
    const { data, error } = await sb.from("site_settings")
      .select("key, value")
      .in("key", ["top_10_movies", "top_10_tv_shows"]);
    if (error) throw new Error(error.message);
    const result: Record<string, unknown[]> = { top_10_movies: [], top_10_tv_shows: [] };
    for (const row of data ?? []) {
      try { result[row["key"] as string] = JSON.parse(row["value"] as string); } catch { /* noop */ }
    }
    // Enrich with titles
    const movies = (result["top_10_movies"] as number[] | undefined) ?? [];
    const tvShows = (result["top_10_tv_shows"] as number[] | undefined) ?? [];
    const allIds = [...movies, ...tvShows];
    if (allIds.length > 0) {
      const { data: content } = await sb.from("content").select("id, title, type, featured").in("id", allIds);
      const contentMap = new Map((content ?? []).map((c: { id: number; title: string; type: string; featured: boolean }) => [c.id, c]));
      result["top_10_movies"] = movies.map((id, i) => ({ rank: i + 1, id, ...(contentMap.get(id) ?? {}) }));
      result["top_10_tv_shows"] = tvShows.map((id, i) => ({ rank: i + 1, id, ...(contentMap.get(id) ?? {}) }));
    }
    return result;
  }

  if (name === "set_top_ten") {
    const ct = String(args["content_type"] ?? "movie");
    const ids = ((args["content_ids"] as number[] | undefined) ?? []).slice(0, 10);
    const key = ct === "tv_show" ? "top_10_tv_shows" : "top_10_movies";
    const now = new Date().toISOString();
    const { error } = await sb.from("site_settings")
      .upsert({ key, value: JSON.stringify(ids), updated_at: now }, { onConflict: "key" });
    if (error) throw new Error(error.message);

    // Sync into top_ten / top_ten_rels relational schema so website displays it
    try {
      const { data: parent } = await sb.from("top_ten").select("id").order("id").limit(1).maybeSingle();
      let pid = parent?.id;
      if (!pid) {
        const ins = await sb.from("top_ten").insert({ created_at: now, updated_at: now }).select("id").single();
        pid = ins.data?.id;
      }
      if (pid && ids.length > 0) {
        await sb.from("top_ten_rels").delete().eq("parent_id", pid).eq("path", key);
        await sb.from("top_ten_rels").insert(ids.map((content_id, i) => ({ parent_id: pid, path: key, content_id, order: i + 1 })));
        await sb.from("top_ten").update({ updated_at: now }).eq("id", pid);
      }
    } catch { /* relational sync best-effort */ }

    // Revalidate
    try {
      const s = await getSettings();
      await revalidateOnflixWeb(s, null, { tmdb_id: 0, media_type: ct === "tv_show" ? "tv" : "movie" });
    } catch { /* revalidation best-effort */ }
    return { success: true, key, count: ids.length, ids };
  }

  if (name === "get_featured") {
    const { data, error } = await sb.from("content")
      .select("id, title, type, status, rating")
      .eq("featured", true)
      .eq("status", "published")
      .order("rating", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  if (name === "set_featured") {
    const id = Number(args["content_id"]);
    const featured = Boolean(args["featured"]);
    // Get content info first
    const { data: contentRow, error: fetchErr } = await sb.from("content")
      .select("id, title, slug, type, featured")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!contentRow) throw new Error(`Content with id ${id} not found`);

    if (featured && !contentRow.featured) {
      // Check current featured count - strict max 8 limit!
      const { count, error: countErr } = await sb.from("content")
        .select("*", { count: "exact", head: true })
        .eq("featured", true)
        .eq("status", "published");
      if (!countErr && (count ?? 0) >= 8) {
        throw new Error(`Hero Slider limit reached: maximum 8 titles allowed (currently ${count} active). Please remove an existing title from the hero slider first before adding '${contentRow.title}'.`);
      }
    }

    const { error } = await sb.from("content")
      .update({ featured, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
    // Revalidate
    try {
      const s = await getSettings();
      await revalidateOnflixWeb(s, contentRow, { tmdb_id: id, media_type: contentRow.type === "tv_show" ? "tv" : "movie" });
    } catch { /* revalidation best-effort */ }
    return { success: true, id, title: contentRow.title, featured };
  }

  if (name === "set_content_status") {
    const id = Number(args["content_id"]);
    const status = String(args["status"] ?? "draft");
    const { data: contentRow, error: fetchErr } = await sb.from("content")
      .select("id, title, slug, type")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!contentRow) throw new Error(`Content with id ${id} not found`);
    const { error } = await sb.from("content")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
    if (status !== "published") {
      await sb.from("content").update({ featured: false }).eq("id", id);
    }
    try {
      const s = await getSettings();
      await revalidateOnflixWeb(s, contentRow, { tmdb_id: id, media_type: contentRow.type === "tv_show" ? "tv" : "movie" });
    } catch { /* revalidation best-effort */ }
    return { success: true, id, title: contentRow.title, status };
  }

  if (name === "delete_content") {
    const id = Number(args["content_id"]);
    const { data: contentRow, error: fetchErr } = await sb.from("content")
      .select("id, title, slug, type")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!contentRow) throw new Error(`Content with id ${id} not found`);
    const { error } = await sb.from("content").delete().eq("id", id);
    if (error) throw new Error(error.message);
    try {
      const s = await getSettings();
      await revalidateOnflixWeb(s, contentRow, { tmdb_id: id, media_type: contentRow.type === "tv_show" ? "tv" : "movie" });
    } catch { /* revalidation best-effort */ }
    return { success: true, id, title: contentRow.title, deleted: true };
  }

  if (name === "get_job_stats") {
    const { data, error } = await sb.from("subtitle_automation_jobs")
      .select("status");
    if (error) throw new Error(error.message);
    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    return { total: (data ?? []).length, by_status: counts };
  }

  if (name === "get_pending_requests") {
    const { data, error } = await sb.from("requests")
      .select("id, title, type, tmdb_id, status, created_at, email")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  if (name === "update_user_request_status") {
    const id = Number(args["request_id"]);
    const status = String(args["status"]);
    const { error } = await sb.from("requests")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
    return { success: true, id, status };
  }

  if (name === "manage_collection") {
    const action = String(args["action"] ?? "list");
    const refreshCollections = async () => {
      try {
        const settings = await getSettings();
        await revalidateOnflixWeb(settings, null, { tmdb_id: 0, media_type: "movie" });
      } catch { /* revalidation is best-effort */ }
    };
    const findContentPath = async (parentId?: number) => {
      let query = sb.from("collections_rels")
        .select("path")
        .not("content_id", "is", null)
        .limit(500);
      if (parentId != null) query = query.eq("parent_id", parentId);
      let { data, error } = await query;
      if (error) throw new Error(error.message);
      if (!data?.length && parentId != null) {
        const result = await sb.from("collections_rels").select("path").not("content_id", "is", null).limit(500);
        data = result.data;
        error = result.error;
        if (error) throw new Error(error.message);
      }
      const counts = new Map<string, number>();
      for (const row of data ?? []) {
        if (typeof row.path === "string" && row.path) counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
      }
      return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "content";
    };
    const makeSlug = (value: string) => value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 150) || `collection-${Date.now()}`;

    if (action === "list") {
      const { data: collections, error } = await sb.from("collections")
        .select("id,name,slug,description,poster_url,backdrop_url,is_public,updated_at")
        .order("updated_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      if (!collections?.length) return { collections: [] };
      const ids = collections.map((item) => item.id);
      const { data: relations, error: relationError } = await sb.from("collections_rels")
        .select("parent_id,path,content_id,order")
        .in("parent_id", ids)
        .not("content_id", "is", null);
      if (relationError) throw new Error(relationError.message);
      const contentIds = [...new Set((relations ?? []).map((row) => row.content_id).filter(Boolean))];
      const { data: titles, error: contentError } = contentIds.length
        ? await sb.from("content").select("id,title,type,status").in("id", contentIds)
        : { data: [], error: null };
      if (contentError) throw new Error(contentError.message);
      const titleById = new Map((titles ?? []).map((item) => [item.id, item]));
      return {
        collections: collections.map((collection) => ({
          ...collection,
          items: (relations ?? [])
            .filter((relation) => relation.parent_id === collection.id)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((relation) => ({ ...titleById.get(relation.content_id), order: relation.order, path: relation.path })),
        })),
      };
    }

    if (action === "create") {
      const name = String(args["name"] ?? "").trim();
      if (!name || name.length > 120) throw new Error("Collection name is required and must be 120 characters or fewer");
      const slug = makeSlug(name);
      const { data: existing, error: existingError } = await sb.from("collections")
        .select("id,name,slug")
        .eq("slug", slug)
        .limit(1)
        .maybeSingle();
      if (existingError) throw new Error(existingError.message);
      if (existing) throw new Error(`Collection '${existing.name}' already exists (ID ${existing.id}); use update or add_items instead`);
      const { data: collection, error } = await sb.from("collections").insert({
        name,
        slug,
        description: String(args["description"] ?? "").trim().slice(0, 4000) || null,
        poster_url: typeof args["poster_url"] === "string" ? args["poster_url"].slice(0, 2000) : null,
        backdrop_url: typeof args["backdrop_url"] === "string" ? args["backdrop_url"].slice(0, 2000) : null,
        is_public: typeof args["is_public"] === "boolean" ? args["is_public"] : true,
      }).select("id,name,slug,description,is_public").single();
      if (error) throw new Error(error.message);
      await refreshCollections();
      return { success: true, collection };
    }

    const collectionId = Number(args["collection_id"]);
    if (!Number.isSafeInteger(collectionId) || collectionId <= 0) throw new Error("A valid collection_id is required");
    const { data: collection, error: collectionError } = await sb.from("collections")
      .select("id,name,slug,poster_url,backdrop_url,is_public")
      .eq("id", collectionId)
      .maybeSingle();
    if (collectionError) throw new Error(collectionError.message);
    if (!collection) throw new Error(`Collection ${collectionId} not found`);

    if (action === "update") {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof args["name"] === "string") {
        const name = args["name"].trim();
        if (!name || name.length > 120) throw new Error("Collection name must be 1-120 characters");
        const slug = makeSlug(name);
        const { data: duplicate, error } = await sb.from("collections").select("id").eq("slug", slug).neq("id", collectionId).limit(1).maybeSingle();
        if (error) throw new Error(error.message);
        if (duplicate) throw new Error(`Another collection already uses slug '${slug}'`);
        patch["name"] = name;
        patch["slug"] = slug;
      }
      if (typeof args["description"] === "string") patch["description"] = args["description"].trim().slice(0, 4000);
      if (typeof args["is_public"] === "boolean") patch["is_public"] = args["is_public"];
      if (typeof args["poster_url"] === "string") patch["poster_url"] = args["poster_url"].slice(0, 2000);
      if (typeof args["backdrop_url"] === "string") patch["backdrop_url"] = args["backdrop_url"].slice(0, 2000);
      if (Object.keys(patch).length === 1) throw new Error("Provide at least one collection field to update");
      const { data: updated, error } = await sb.from("collections").update(patch).eq("id", collectionId)
        .select("id,name,slug,description,poster_url,backdrop_url,is_public").single();
      if (error) throw new Error(error.message);
      await refreshCollections();
      return { success: true, collection: updated };
    }

    if (action === "add_items" || action === "remove_items") {
      const rawIds = Array.isArray(args["content_ids"]) ? args["content_ids"].map(Number) : [];
      const contentIds = [...new Set(rawIds)];
      if (!contentIds.length || contentIds.length > 50 || contentIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new Error("Provide 1-50 valid positive OnFlix content IDs");
      }
      const path = await findContentPath(collectionId);
      if (action === "remove_items") {
        const { error } = await sb.from("collections_rels").delete()
          .eq("parent_id", collectionId)
          .eq("path", path)
          .in("content_id", contentIds);
        if (error) throw new Error(error.message);
        await sb.from("collections").update({ updated_at: new Date().toISOString() }).eq("id", collectionId);
        await refreshCollections();
        return { success: true, collection_id: collectionId, removed_content_ids: contentIds, relationship_path: path };
      }

      const { data: titles, error: contentError } = await sb.from("content")
        .select("id,title,type,status,poster_url,backdrop_url")
        .in("id", contentIds);
      if (contentError) throw new Error(contentError.message);
      const titleById = new Map((titles ?? []).map((item) => [item.id, item]));
      const invalidIds = contentIds.filter((id) => titleById.get(id)?.status !== "published");
      if (invalidIds.length) throw new Error(`These content IDs are missing or not published: ${invalidIds.join(", ")}`);

      const { data: current, error: relationError } = await sb.from("collections_rels")
        .select("content_id,order")
        .eq("parent_id", collectionId);
      if (relationError) throw new Error(relationError.message);
      const existingIds = new Set((current ?? []).map((item) => item.content_id));
      let order = Math.max(0, ...(current ?? []).map((item) => Number(item.order) || 0));
      const additions = contentIds.filter((id) => !existingIds.has(id)).map((contentId) => ({
        parent_id: collectionId,
        path,
        content_id: contentId,
        order: ++order,
      }));
      if (additions.length) {
        const { error } = await sb.from("collections_rels").insert(additions);
        if (error) throw new Error(error.message);
      }
      const firstTitle = titleById.get(contentIds[0]);
      const coverPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (!collection.poster_url && firstTitle?.poster_url) coverPatch["poster_url"] = firstTitle.poster_url;
      if (!collection.backdrop_url && firstTitle?.backdrop_url) coverPatch["backdrop_url"] = firstTitle.backdrop_url;
      const { error: updateError } = await sb.from("collections").update(coverPatch).eq("id", collectionId);
      if (updateError) throw new Error(updateError.message);
      await refreshCollections();
      return {
        success: true,
        collection_id: collectionId,
        added: additions.map((item) => ({ id: item.content_id, title: titleById.get(item.content_id)?.title })),
        already_present_content_ids: contentIds.filter((id) => existingIds.has(id)),
        relationship_path: path,
      };
    }

    throw new Error(`Unsupported collection action: ${action}`);
  }

  if (name === "get_collection_catalog") {
    const requestedType = String(args["content_type"] ?? "both");
    const types = requestedType === "movie" || requestedType === "tv_show"
      ? [requestedType]
      : ["movie", "tv_show"];
    const limit = Math.max(5, Math.min(20, Math.floor(Number(args["limit_per_type"]) || 12)));
    const byType = await Promise.all(types.map(async (type) => {
      const [listResult, countResult] = await Promise.all([
        sb.from("content")
          .select("id,tmdb_id,title,type,overview,release_year,year,rating,vote_count")
          .eq("status", "published")
          .eq("type", type)
          .order("rating", { ascending: false, nullsFirst: false })
          .limit(limit),
        sb.from("content").select("id", { count: "exact", head: true }).eq("status", "published").eq("type", type),
      ]);
      if (listResult.error) throw new Error(listResult.error.message);
      if (countResult.error) throw new Error(countResult.error.message);
      return { type, total_published: countResult.count ?? 0, candidates: listResult.data ?? [] };
    }));
    const contentIds = byType.flatMap((group) => group.candidates.map((item) => item.id));
    const { data: relations, error: relationError } = contentIds.length
      ? await sb.from("content_rels").select("parent_id,genres_id").in("parent_id", contentIds).not("genres_id", "is", null)
      : { data: [], error: null };
    if (relationError) throw new Error(relationError.message);
    const genreIds = [...new Set((relations ?? []).map((relation) => relation.genres_id).filter(Boolean))];
    const { data: genreRows, error: genreError } = genreIds.length
      ? await sb.from("genres").select("id,name,slug").in("id", genreIds)
      : { data: [], error: null };
    if (genreError) throw new Error(genreError.message);
    const genreById = new Map((genreRows ?? []).map((genre) => [genre.id, genre]));
    const genresByContent = new Map<number, Array<{ id: number; name: string; slug: string }>>();
    for (const relation of relations ?? []) {
      const genre = genreById.get(relation.genres_id);
      if (genre) genresByContent.set(relation.parent_id, [...(genresByContent.get(relation.parent_id) ?? []), genre]);
    }
    const genreCounts = new Map<string, number>();
    const results = byType.map((group) => ({
      ...group,
      candidates: group.candidates.map((item) => {
        const genres = genresByContent.get(item.id) ?? [];
        for (const genre of genres) genreCounts.set(genre.name, (genreCounts.get(genre.name) ?? 0) + 1);
        return {
          id: item.id,
          tmdb_id: item.tmdb_id,
          title: item.title,
          type: item.type,
          year: item.release_year ?? item.year,
          rating: item.rating,
          vote_count: item.vote_count,
          overview: item.overview?.slice(0, 220),
          genres: genres.map((genre) => genre.name),
        };
      }),
    }));
    return {
      published_totals: Object.fromEntries(byType.map((group) => [group.type, group.total_published])),
      genre_counts_in_candidates: [...genreCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      by_type: results,
    };
  }

  if (name === "search_web") {
    const query = String(args["query"] ?? "").trim();
    if (!query || query.length > 500) throw new Error("Web search query is required and must be 500 characters or fewer");
    const apiKey = process.env["TAVILY_API_KEY"]?.trim();
    if (!apiKey) throw new Error("Web search is not configured. Add the server-side TAVILY_API_KEY to the local .env or deployment secrets.");
    const maxResults = Math.max(3, Math.min(6, Math.floor(Number(args["max_results"]) || 5)));
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: maxResults, include_answer: false }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}`);
    const data = await response.json() as {
      results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string | null }>;
    };
    return {
      query,
      results: (data.results ?? []).slice(0, maxResults).map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content?.slice(0, 600),
        published_date: result.published_date,
      })),
    };
  }

  if (name === "search_tmdb_collections") {
    const { tmdb } = await import("@/lib/engine.server");
    const query = String(args["query"] ?? "").trim();
    if (!query || query.length > 200) throw new Error("TMDB collection query is required and must be 200 characters or fewer");
    const maxResults = Math.max(1, Math.min(5, Math.floor(Number(args["max_results"]) || 3)));
    const search = await tmdb("/search/collection", { query }) as {
      results?: Array<{ id: number; name: string; overview?: string; poster_path?: string | null; backdrop_path?: string | null }>;
    };
    const matches = await Promise.all((search.results ?? []).slice(0, maxResults).map(async (item) => {
      const details = await tmdb(`/collection/${item.id}`) as {
        id: number;
        name: string;
        overview?: string;
        poster_path?: string | null;
        backdrop_path?: string | null;
        parts?: Array<{ id: number; title: string; release_date?: string; poster_path?: string | null }>;
      };
      const movieIds = [...new Set((details.parts ?? []).map((part) => part.id))];
      if (!movieIds.length) return { tmdb_collection_id: details.id, name: details.name, overview: details.overview, poster_path: details.poster_path, backdrop_path: details.backdrop_path, published_onflix_films: [] };
      const { data: localTitles, error } = await sb.from("content")
        .select("id,tmdb_id,title,type,status,release_year,rating,vote_count")
        .in("tmdb_id", movieIds)
        .eq("type", "movie")
        .eq("status", "published");
      if (error) throw new Error(error.message);
      const localByTmdbId = new Map((localTitles ?? []).map((title) => [Number(title.tmdb_id), title]));
      const publishedOnflixFilms = (details.parts ?? []).flatMap((part) => {
        const title = localByTmdbId.get(part.id);
        return title ? [{ ...title, tmdb_title: part.title, tmdb_release_date: part.release_date }] : [];
      });
      return {
        tmdb_collection_id: details.id,
        name: details.name,
        overview: details.overview?.slice(0, 400),
        poster_path: details.poster_path,
        backdrop_path: details.backdrop_path,
        published_onflix_films: publishedOnflixFilms,
      };
    }));
    return { query, results: matches };
  }

  if (name === "present_collection_options") {
    const { tmdb } = await import("@/lib/engine.server");
    const inputOptions = Array.isArray(args["options"]) ? args["options"] : [];
    if (inputOptions.length < 3 || inputOptions.length > 5) throw new Error("Provide between 3 and 5 researched collection options");
    const options = await Promise.all(inputOptions.map(async (raw, index) => {
      const option = raw as Record<string, unknown>;
      const name = String(option["name"] ?? "").trim();
      const description = String(option["description"] ?? "").trim();
      const contentIds = Array.isArray(option["content_ids"]) ? [...new Set(option["content_ids"].map(Number))] : [];
      if (!name || name.length > 120 || !description || description.length > 500) throw new Error(`Option ${index + 1} needs a title and a description under 500 characters`);
      if (!contentIds.length || contentIds.length > 30 || contentIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new Error(`Option ${index + 1} must include 1-30 valid OnFlix content IDs`);
      }
      const { data: titles, error } = await sb.from("content")
        .select("id,tmdb_id,title,type,status,release_year,year,rating")
        .in("id", contentIds)
        .eq("status", "published");
      if (error) throw new Error(error.message);
      const titleById = new Map((titles ?? []).map((title) => [title.id, title]));
      if (titleById.size !== contentIds.length) throw new Error(`Option '${name}' contains titles not found or not published on OnFlix`);

      const tmdbCollectionId = Number(option["tmdb_collection_id"]);
      let posterPath: string | null = null;
      let backdropPath: string | null = null;
      if (Number.isSafeInteger(tmdbCollectionId) && tmdbCollectionId > 0) {
        const details = await tmdb(`/collection/${tmdbCollectionId}`) as {
          id: number;
          poster_path?: string | null;
          backdrop_path?: string | null;
          parts?: Array<{ id: number }>;
        };
        const partIds = new Set((details.parts ?? []).map((part) => part.id));
        const nonMemberIds = (titles ?? []).filter((title) => title.type !== "movie" || !partIds.has(Number(title.tmdb_id)));
        if (nonMemberIds.length) throw new Error(`Option '${name}' includes titles outside its TMDB collection`);
        posterPath = details.poster_path ?? null;
        backdropPath = details.backdrop_path ?? null;
      } else {
        for (const title of (titles ?? []).slice(0, 5)) {
          try {
            const type = title.type === "tv_show" ? "tv" : "movie";
            const details = await tmdb(`/${type}/${title.tmdb_id}`) as { poster_path?: string | null; backdrop_path?: string | null };
            posterPath ??= details.poster_path ?? null;
            backdropPath ??= details.backdrop_path ?? null;
            if (posterPath && backdropPath) break;
          } catch { /* try another selected title for artwork */ }
        }
      }
      const toImageUrl = (size: "w500" | "w1280", path: string | null) =>
        path && path.startsWith("/") ? `https://image.tmdb.org/t/p/${size}${path}` : null;
      const sourceUrls = (Array.isArray(option["source_urls"]) ? option["source_urls"] : [])
        .filter((url): url is string => typeof url === "string" && /^https:\/\//i.test(url))
        .slice(0, 4);
      return {
        id: `${index + 1}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
        name,
        description,
        tmdb_collection_id: Number.isSafeInteger(tmdbCollectionId) && tmdbCollectionId > 0 ? tmdbCollectionId : null,
        poster_url: toImageUrl("w500", posterPath),
        backdrop_url: toImageUrl("w1280", backdropPath),
        items: (titles ?? []).map((title) => ({
          id: title.id,
          tmdb_id: title.tmdb_id,
          title: title.title,
          type: title.type,
          year: title.release_year ?? title.year,
          rating: title.rating,
        })),
        source_urls: sourceUrls,
      };
    }));
    return { options };
  }

  if (name === "search_tmdb") {
    const { tmdb } = await import("@/lib/engine.server");
    const q = String(args["query_or_id"] ?? "").trim();
    const mt = (args["media_type"] as string | undefined) ?? "movie";
    const mediaTypes = mt === "any" ? ["movie", "tv"] as const : [mt === "tv" ? "tv" : "movie"] as const;
    if (/^\d+$/.test(q)) {
      const results = await Promise.all(mediaTypes.map(async (type) => {
        try {
          const d = await tmdb(`/${type}/${q}`) as {
            id: number;
            title?: string;
            name?: string;
            release_date?: string;
            first_air_date?: string;
            overview?: string;
            vote_average?: number;
            vote_count?: number;
            poster_path?: string | null;
            backdrop_path?: string | null;
          };
          return {
            id: d.id,
            title: d.title || d.name,
            type,
            release_date: d.release_date || d.first_air_date,
            overview: d.overview?.slice(0, 300),
            vote_average: d.vote_average,
            vote_count: d.vote_count,
            poster_path: d.poster_path,
            backdrop_path: d.backdrop_path,
          };
        } catch {
          return null;
        }
      }));
      const found = results.filter((item) => item !== null);
      return found.length ? found : { error: `TMDB ID ${q} not found on TMDB.` };
    }
    try {
      const results = await Promise.all(mediaTypes.map(async (type) => {
        const searchRes = await tmdb(`/search/${type}`, { query: q }) as {
          results?: Array<{
            id: number;
            title?: string;
            name?: string;
            release_date?: string;
            first_air_date?: string;
            overview?: string;
            vote_average?: number;
            vote_count?: number;
            poster_path?: string | null;
            backdrop_path?: string | null;
          }>;
        };
        return (searchRes.results ?? []).slice(0, 5).map((r) => ({
          id: r.id,
          title: r.title || r.name,
          type,
          release_date: r.release_date || r.first_air_date,
          overview: r.overview?.slice(0, 300),
          vote_average: r.vote_average,
          vote_count: r.vote_count,
          poster_path: r.poster_path,
          backdrop_path: r.backdrop_path,
        }));
      }));
      return results.flat();
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  if (name === "queue_title") {
    const { tmdb } = await import("@/lib/engine.server");
    const tmdbId = Number(args["tmdb_id"]);
    let mediaType = (args["media_type"] as string) === "tv" ? "tv" : "movie";
    const season = Number(args["season"] || 0);
    const episode = Number(args["episode"] || 0);

    let title = "";
    let releaseDate: string | null = null;
    let popularity = 0;
    let runtime: number | null = null;
    let posterPath: string | null = null;

    try {
      if (mediaType === "movie") {
        try {
          const d = await tmdb(`/movie/${tmdbId}`) as {
            title: string;
            release_date?: string;
            popularity?: number;
            runtime?: number;
            poster_path?: string;
          };
          title = d.title;
          releaseDate = d.release_date || null;
          popularity = d.popularity ?? 0;
          runtime = d.runtime ?? null;
          posterPath = d.poster_path ?? null;
        } catch (mErr) {
          if (!args["media_type"]) {
            // Fallback: try TV show
            const d = await tmdb(`/tv/${tmdbId}`) as {
              name: string;
              first_air_date?: string;
              popularity?: number;
              poster_path?: string;
            };
            mediaType = "tv";
            title = `${d.name} S${season || 1}E${episode || 1}`;
            releaseDate = d.first_air_date || null;
            popularity = d.popularity ?? 0;
            posterPath = d.poster_path ?? null;
          } else {
            throw mErr;
          }
        }
      } else {
        const d = await tmdb(`/tv/${tmdbId}`) as {
          name: string;
          first_air_date?: string;
          popularity?: number;
          poster_path?: string;
        };
        title = `${d.name} S${season || 1}E${episode || 1}`;
        releaseDate = d.first_air_date || null;
        popularity = d.popularity ?? 0;
        posterPath = d.poster_path ?? null;
      }
    } catch {
      throw new Error(`TMDB ID ${tmdbId} was not found on TMDB.`);
    }

    const { data: row, error } = await sb
      .from("subtitle_automation_jobs")
      .upsert(
        {
          tmdb_id: tmdbId,
          media_type: mediaType,
          title,
          season_number: season,
          episode_number: episode,
          release_date: releaseDate,
          popularity,
          runtime,
          poster_path: posterPath,
          status: "waiting_embed",
          next_retry_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tmdb_id,media_type,season_number,episode_number" },
      )
      .select("id, title, status, tmdb_id")
      .single();

    if (error) throw new Error(error.message);
    return { success: true, message: `Successfully queued '${title}' (TMDB ID: ${tmdbId}) for subtitle automation.`, job: row };
  }

  if (name === "auto_curate_top_ten") {
    const ct = String(args["content_type"] ?? "movie");
    const criteria = String(args["criteria"] ?? "rating");
    let query = sb.from("content")
      .select("id, title, rating, vote_count, release_year, created_at")
      .eq("type", ct)
      .eq("status", "published");

    if (criteria === "rating") {
      query = query.order("rating", { ascending: false }).order("vote_count", { ascending: false });
    } else {
      query = query.order("release_year", { ascending: false }).order("created_at", { ascending: false });
    }

    const { data: items, error } = await query.limit(10);
    if (error) throw new Error(error.message);
    const ids = (items ?? []).map((it) => it["id"] as number);
    const key = ct === "tv_show" ? "top_10_tv_shows" : "top_10_movies";
    const now = new Date().toISOString();
    await sb.from("site_settings")
      .upsert({ key, value: JSON.stringify(ids), updated_at: now }, { onConflict: "key" });

    // Sync into top_ten / top_ten_rels relational schema
    try {
      const { data: parent } = await sb.from("top_ten").select("id").order("id").limit(1).maybeSingle();
      let pid = parent?.id;
      if (!pid) {
        const ins = await sb.from("top_ten").insert({ created_at: now, updated_at: now }).select("id").single();
        pid = ins.data?.id;
      }
      if (pid && ids.length > 0) {
        await sb.from("top_ten_rels").delete().eq("parent_id", pid).eq("path", key);
        await sb.from("top_ten_rels").insert(ids.map((content_id, i) => ({ parent_id: pid, path: key, content_id, order: i + 1 })));
        await sb.from("top_ten").update({ updated_at: now }).eq("id", pid);
      }
    } catch { /* relational sync best-effort */ }

    try {
      const s = await getSettings();
      await revalidateOnflixWeb(s, null, { tmdb_id: 0, media_type: ct === "tv_show" ? "tv" : "movie" });
    } catch { /* best-effort */ }
    return {
      success: true,
      key,
      criteria,
      count: ids.length,
      top_10: (items ?? []).map((it, i) => ({ rank: i + 1, id: it["id"], title: it["title"], rating: it["rating"] })),
    };
  }

  if (name === "auto_curate_hero_slider") {
    const criteria = String(args["criteria"] ?? "rating");
    // Strict limit: exactly 7 to 8 items maximum (never exceed 8)
    const count = Math.min(Math.max(1, Number(args["count"] ?? 8)), 8);
    let query = sb.from("content")
      .select("id, title, rating, vote_count, type, backdrop_url, poster_url")
      .eq("status", "published");
    if (criteria === "rating") {
      query = query.order("rating", { ascending: false }).order("vote_count", { ascending: false });
    } else {
      query = query.order("release_year", { ascending: false }).order("created_at", { ascending: false });
    }
    const { data: topItems, error } = await query.limit(count);
    if (error) throw new Error(error.message);
    const newFeaturedIds = (topItems ?? []).map((it) => it["id"] as number);
    const now = new Date().toISOString();
    await sb.from("content").update({ featured: false, updated_at: now }).eq("featured", true);
    if (newFeaturedIds.length > 0) {
      await sb.from("content").update({ featured: true, updated_at: now }).in("id", newFeaturedIds);
    }
    try {
      const s = await getSettings();
      await revalidateOnflixWeb(s, null, { tmdb_id: 0, media_type: "movie" });
    } catch { /* best-effort */ }
    return {
      success: true,
      criteria,
      featured_count: newFeaturedIds.length,
      max_limit: 8,
      titles: (topItems ?? []).map((it, i) => ({ rank: i + 1, id: it["id"], title: it["title"], rating: it["rating"], type: it["type"] })),
    };
  }

  if (name === "check_embed_health") {
    const target = String(args["target"] ?? "top_ten");
    const contentId = Number(args["content_id"] || 0);
    const s = await getSettings();
    const { probeEmbed } = await import("@/lib/engine.server");

    let targets: Array<{ id: number; title: string; tmdb_id: number; type: string }> = [];

    if (target === "specific" && contentId) {
      const { data } = await sb.from("content").select("id, title, tmdb_id, type").eq("id", contentId).maybeSingle();
      if (data && data["tmdb_id"]) targets = [data as any];
    } else if (target === "featured") {
      const { data } = await sb.from("content").select("id, title, tmdb_id, type").eq("featured", true).eq("status", "published").limit(8);
      targets = (data ?? []).filter((d) => Boolean(d["tmdb_id"])) as any;
    } else {
      const { data } = await sb.from("site_settings").select("value").eq("key", "top_10_movies").maybeSingle();
      let ids: number[] = [];
      try { ids = JSON.parse(data?.value ?? "[]"); } catch {}
      if (ids.length > 0) {
        const { data: movies } = await sb.from("content").select("id, title, tmdb_id, type").in("id", ids);
        targets = (movies ?? []).filter((d) => Boolean(d["tmdb_id"])) as any;
      }
    }

    if (targets.length === 0) {
      return { message: "No content items with TMDB IDs found to inspect." };
    }

    const results = await Promise.all(
      targets.slice(0, 10).map(async (t) => {
        const healthy = await probeEmbed(s, { tmdb_id: t["tmdb_id"], media_type: t["type"] === "tv_show" ? "tv" : "movie", season_number: 1, episode_number: 1 });
        return { id: t["id"], title: t["title"], tmdb_id: t["tmdb_id"], status: healthy ? "playable" : "broken_or_no_source" };
      }),
    );

    const healthyCount = results.filter((r) => r.status === "playable").length;
    const brokenCount = results.filter((r) => r.status !== "playable").length;
    return { target, total_checked: results.length, healthy_count: healthyCount, broken_count: brokenCount, results };
  }

  if (name === "auto_fulfill_requests") {
    const limit = Math.min(Math.max(1, Number(args["limit"] ?? 5)), 15);
    const { data: requests, error } = await sb.from("requests")
      .select("id, title, tmdb_id, type")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    if (!requests || requests.length === 0) {
      return { message: "No pending user requests to fulfill." };
    }

    const { tmdb } = await import("@/lib/engine.server");
    const fulfilled: Array<{ id: number; title: string; tmdb_id: number; status: string }> = [];

    for (const req of requests) {
      try {
        const mediaType = req["type"] === "tv" ? "tv" : "movie";
        let title = req["title"] as string;
        let releaseDate: string | null = null;
        let popularity = 0;
        let runtime: number | null = null;
        let posterPath: string | null = null;

        if (mediaType === "movie") {
          const d = await tmdb(`/movie/${req["tmdb_id"]}`) as any;
          title = d.title || title;
          releaseDate = d.release_date || null;
          popularity = d.popularity ?? 0;
          runtime = d.runtime ?? null;
          posterPath = d.poster_path ?? null;
        } else {
          const d = await tmdb(`/tv/${req["tmdb_id"]}`) as any;
          title = `${d.name || title} S1E1`;
          releaseDate = d.first_air_date || null;
          popularity = d.popularity ?? 0;
          posterPath = d.poster_path ?? null;
        }

        await sb.from("subtitle_automation_jobs").upsert(
          {
            tmdb_id: req["tmdb_id"],
            media_type: mediaType,
            title,
            season_number: mediaType === "tv" ? 1 : 0,
            episode_number: mediaType === "tv" ? 1 : 0,
            release_date: releaseDate,
            popularity,
            runtime,
            poster_path: posterPath,
            status: "waiting_embed",
            next_retry_at: null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tmdb_id,media_type,season_number,episode_number" },
        );

        await sb.from("requests").update({ status: "approved", updated_at: new Date().toISOString() }).eq("id", req["id"]);
        fulfilled.push({ id: req["id"], title, tmdb_id: req["tmdb_id"], status: "queued_and_approved" });
      } catch (err) {
        fulfilled.push({ id: req["id"], title: req["title"], tmdb_id: req["tmdb_id"], status: `failed: ${(err as Error).message}` });
      }
    }

    return { total_processed: fulfilled.length, fulfilled };
  }

  if (name === "get_health_report") {
    const { count: totalMovies } = await sb.from("content").select("id", { count: "exact", head: true }).eq("type", "movie").eq("status", "published");
    const { count: totalTv } = await sb.from("content").select("id", { count: "exact", head: true }).eq("type", "tv_show").eq("status", "published");
    const { data: missingSubMovies, count: missingMovieSubs } = await sb.from("content")
      .select("id, title, type, tmdb_id")
      .eq("type", "movie")
      .is("sinhala_subtitle_url", null)
      .eq("status", "published")
      .limit(10);

    const { data: jobs } = await sb.from("subtitle_automation_jobs").select("status");
    const jobCounts: Record<string, number> = {};
    for (const j of jobs ?? []) jobCounts[j["status"]] = (jobCounts[j["status"]] ?? 0) + 1;

    const { count: pendingRequests } = await sb.from("requests").select("id", { count: "exact", head: true }).eq("status", "pending");

    return {
      platform: "OnFlix Streaming",
      published_content: {
        movies: totalMovies ?? 0,
        tv_shows: totalTv ?? 0,
        total: (totalMovies ?? 0) + (totalTv ?? 0),
        missing_movie_subtitles_count: missingMovieSubs ?? 0,
        missing_movies: (missingSubMovies ?? []).map((m) => ({ id: m["id"], title: m["title"], type: m["type"], tmdb_id: m["tmdb_id"] })),
        tv_show_subtitle_note: "TV Show subtitles are managed per episode in the episodes table. Unreleased episodes do not count as missing.",
      },
      automation_jobs: {
        total: (jobs ?? []).length,
        completed: jobCounts["completed"] ?? 0,
        processing: jobCounts["processing"] ?? 0,
        waiting_embed: jobCounts["waiting_embed"] ?? 0,
        waiting_subtitle: jobCounts["waiting_subtitle"] ?? 0,
        failed: jobCounts["failed"] ?? 0,
      },
      user_requests: {
        pending_review: pendingRequests ?? 0,
      },
      status: (jobCounts["failed"] ?? 0) > 10 ? "attention_needed" : "healthy",
    };
  }

  if (name === "get_missing_subtitles") {
    const limit = Math.min(Math.max(1, Number(args["limit"] ?? 20)), 50);
    const contentType = (args["content_type"] as string | undefined) ?? "all";

    type SubtitleMissingItem = {
      id: number;
      title: string;
      type: string;
      tmdb_id: number;
      year: number | null;
      rating: number | null;
      note?: string;
    };
    const results: SubtitleMissingItem[] = [];

    // 1. Movies (subtitles stored on content.sinhala_subtitle_url)
    if (contentType === "movie" || contentType === "all") {
      const { data: movies, error } = await sb.from("content")
        .select("id, title, type, tmdb_id, release_year, rating")
        .eq("type", "movie")
        .is("sinhala_subtitle_url", null)
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      for (const m of movies ?? []) {
        results.push({
          id: m["id"] as number,
          title: m["title"] as string,
          type: "movie",
          tmdb_id: m["tmdb_id"] as number,
          year: m["release_year"] as number | null,
          rating: m["rating"] as number | null,
          note: "Movie subtitle missing",
        });
      }
    }

    // 2. TV Shows (only released episodes with embed_link or published status)
    if (contentType === "tv_show" || (contentType === "all" && results.length < limit)) {
      const { data: tvShows, error: tvErr } = await sb.from("content")
        .select("id, title, tmdb_id, release_year, rating")
        .eq("type", "tv_show")
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(10);
      if (!tvErr && tvShows) {
        for (const show of tvShows) {
          if (results.length >= limit) break;
          const { data: missingEps } = await sb.from("episodes")
            .select("season, episode, title")
            .eq("content_id", show["id"])
            .not("embed_link", "is", null)
            .or("sinhala_subtitle_url.is.null,sinhala_subtitle_url.eq.''")
            .limit(5);

          if (missingEps && missingEps.length > 0) {
            results.push({
              id: show["id"] as number,
              title: show["title"] as string,
              type: "tv_show",
              tmdb_id: show["tmdb_id"] as number,
              year: show["release_year"] as number | null,
              rating: show["rating"] as number | null,
              note: `Missing subs for released episode(s): ${missingEps.map((e) => `S${e["season"]}E${e["episode"]}`).join(", ")}`,
            });
          }
        }
      }
    }

    return {
      filter: contentType,
      total_found: results.length,
      explanation: contentType === "movie"
        ? "Showing published movies without Sinhala subtitles."
        : "For TV shows, only released episodes with video are checked. Unreleased/future episodes do not require subtitles until aired.",
      titles: results,
    };
  }

  if (name === "queue_missing_subtitles") {
    const limit = Math.min(Math.max(1, Number(args["limit"] ?? 5)), 15);
    const { data: missing, error } = await sb.from("content")
      .select("id, title, type, tmdb_id")
      .is("sinhala_subtitle_url", null)
      .eq("status", "published")
      .limit(limit);
    if (error) throw new Error(error.message);
    if (!missing || missing.length === 0) return { message: "All published content already has Sinhala subtitles!" };

    const { tmdb } = await import("@/lib/engine.server");
    const queued: Array<{ id: number; title: string; tmdb_id: number; status: string }> = [];

    for (const item of missing) {
      if (!item["tmdb_id"]) continue;
      try {
        const mediaType = item["type"] === "tv_show" ? "tv" : "movie";
        let title = item["title"] as string;
        let releaseDate: string | null = null;
        let popularity = 0;
        let runtime: number | null = null;
        let posterPath: string | null = null;

        if (mediaType === "movie") {
          const d = await tmdb(`/movie/${item["tmdb_id"]}`) as any;
          title = d.title || title;
          releaseDate = d.release_date || null;
          popularity = d.popularity ?? 0;
          runtime = d.runtime ?? null;
          posterPath = d.poster_path ?? null;
        } else {
          const d = await tmdb(`/tv/${item["tmdb_id"]}`) as any;
          title = `${d.name || title} S1E1`;
          releaseDate = d.first_air_date || null;
          popularity = d.popularity ?? 0;
          posterPath = d.poster_path ?? null;
        }

        await sb.from("subtitle_automation_jobs").upsert(
          {
            tmdb_id: item["tmdb_id"],
            media_type: mediaType,
            title,
            season_number: mediaType === "tv" ? 1 : 0,
            episode_number: mediaType === "tv" ? 1 : 0,
            release_date: releaseDate,
            popularity,
            runtime,
            poster_path: posterPath,
            status: "waiting_embed",
            next_retry_at: null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tmdb_id,media_type,season_number,episode_number" },
        );
        queued.push({ id: item["id"], title, tmdb_id: item["tmdb_id"], status: "queued" });
      } catch (err) {
        queued.push({ id: item["id"], title: item["title"], tmdb_id: item["tmdb_id"], status: `failed: ${(err as Error).message}` });
      }
    }

    return { total_queued: queued.length, queued };
  }

  if (name === "manage_announcement") {
    const action = String(args["action"] ?? "get");
    if (action === "get") {
      const { data } = await sb.from("site_settings").select("value").eq("key", "site_announcement").maybeSingle();
      try { return data?.value ? JSON.parse(data.value) : { enabled: false, message: "" }; }
      catch { return { enabled: false, message: data?.value ?? "" }; }
    }
    if (action === "disable") {
      await sb.from("site_settings").upsert({ key: "site_announcement", value: JSON.stringify({ enabled: false, message: "", updated_at: new Date().toISOString() }) }, { onConflict: "key" });
      try { const s = await getSettings(); await revalidateOnflixWeb(s, null, { tmdb_id: 0, media_type: "movie" }); } catch {}
      return { success: true, enabled: false, message: "Announcement disabled" };
    }
    const message = String(args["message"] ?? "").trim();
    const type = String(args["type"] ?? "info");
    const val = { enabled: true, message, type, updated_at: new Date().toISOString() };
    await sb.from("site_settings").upsert({ key: "site_announcement", value: JSON.stringify(val) }, { onConflict: "key" });
    try { const s = await getSettings(); await revalidateOnflixWeb(s, null, { tmdb_id: 0, media_type: "movie" }); } catch {}
    return { success: true, ...val };
  }

  if (name === "manage_glossary") {
    const action = String(args["action"] ?? "list");
    const { data } = await sb.from("site_settings").select("value").eq("key", "sinhala_glossary").maybeSingle();
    let glossary: Record<string, string> = {};
    try { glossary = data?.value ? JSON.parse(data.value) : {}; } catch {}

    if (action === "list") {
      return { total_terms: Object.keys(glossary).length, terms: glossary };
    }
    if (action === "add") {
      const en = String(args["english"] ?? "").trim();
      const si = String(args["sinhala"] ?? "").trim();
      if (!en || !si) throw new Error("Both english and sinhala are required to add a glossary term");
      glossary[en] = si;
      await sb.from("site_settings").upsert({ key: "sinhala_glossary", value: JSON.stringify(glossary), updated_at: new Date().toISOString() }, { onConflict: "key" });
      return { success: true, added: { [en]: si }, total_terms: Object.keys(glossary).length };
    }
    if (action === "remove") {
      const en = String(args["english"] ?? "").trim();
      delete glossary[en];
      await sb.from("site_settings").upsert({ key: "sinhala_glossary", value: JSON.stringify(glossary), updated_at: new Date().toISOString() }, { onConflict: "key" });
      return { success: true, removed: en, total_terms: Object.keys(glossary).length };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ─── Multi-Provider AI Fallback Engine (Groq -> GitHub Models -> OpenRouter) ─
type ProviderConfig = {
  name: string;
  endpoint: string;
  getKey: () => string | undefined;
  models: readonly string[];
  extraHeaders?: Record<string, string>;
};

const PROVIDERS: ProviderConfig[] = [
  {
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    getKey: () => process.env["GROQ_API_KEY"],
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
  },
  {
    name: "GitHub Models",
    endpoint: "https://models.inference.ai.azure.com/chat/completions",
    getKey: () => process.env["GITHUB_TOKEN"] || process.env["GITHUB_PAT"],
    models: ["gpt-4o-mini", "gpt-4o", "meta-llama-3.1-70b-instruct"],
  },
  {
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    getKey: () => process.env["OPENROUTER_API_KEY"],
    models: ["meta-llama/llama-3.3-70b-instruct:free", "openai/gpt-4o-mini", "google/gemini-2.0-flash-001"],
    extraHeaders: {
      "HTTP-Referer": "https://onflixlk.vercel.app",
      "X-Title": "OnFlix Co-Pilot",
    },
  },
];

type ProviderChatResponse = {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
};

async function callAIWithFailover(
  groqMessages: unknown[],
  tools: readonly unknown[],
): Promise<ProviderChatResponse> {
  const activeProviders = PROVIDERS.filter((p) => Boolean(p.getKey()?.trim()));

  if (activeProviders.length === 0) {
    throw new Error(
      "No AI API keys configured. Set GROQ_API_KEY, GITHUB_TOKEN, or OPENROUTER_API_KEY in .env.",
    );
  }

  const errors: string[] = [];

  for (const provider of activeProviders) {
    const key = provider.getKey()!.trim();

    for (const model of provider.models) {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          ...(provider.extraHeaders ?? {}),
        };

        const res = await fetch(provider.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: groqMessages,
            tools,
            tool_choice: "auto",
            temperature: 0.2,
            max_tokens: 1024,
          }),
        });

        if (res.ok) {
          return (await res.json()) as ProviderChatResponse;
        }

        const errText = await res.text();
        errors.push(`[${provider.name}:${model}] ${res.status}: ${errText.slice(0, 150)}`);

        // If 429 rate-limited on this model, continue to next model/provider immediately
        if (res.status === 429) {
          continue;
        }
      } catch (err) {
        errors.push(`[${provider.name}:${model}] ${(err as Error).message}`);
      }
    }
  }

  throw new Error(
    `All AI providers exhausted. ${errors[errors.length - 1] ?? "Please retry in a few seconds."}`,
  );
}

async function createSelectedCollection(option: z.infer<typeof SelectedCollectionOptionSchema>) {
  const { db, tmdb } = await import("@/lib/engine.server");
  const contentIds = [...new Set(option.items.map((item) => item.id))];
  if (contentIds.length !== option.items.length) throw new Error("Selected collection contains duplicate titles");

  const sb = db();
  const { data: titles, error } = await sb.from("content")
    .select("id,tmdb_id,title,type,status")
    .in("id", contentIds)
    .eq("status", "published");
  if (error) throw new Error(error.message);
  const titleById = new Map((titles ?? []).map((title) => [title.id, title]));
  if (titleById.size !== contentIds.length) throw new Error("Some selected titles are no longer published on OnFlix");
  for (const selected of option.items) {
    const current = titleById.get(selected.id);
    if (!current || Number(current.tmdb_id) !== selected.tmdb_id || current.type !== selected.type) {
      throw new Error(`Selected title '${selected.title}' no longer matches the OnFlix catalog`);
    }
  }

  let posterPath: string | null = null;
  let backdropPath: string | null = null;
  if (option.tmdb_collection_id) {
    const details = await tmdb(`/collection/${option.tmdb_collection_id}`) as {
      parts?: Array<{ id: number }>;
      poster_path?: string | null;
      backdrop_path?: string | null;
    };
    const partIds = new Set((details.parts ?? []).map((part) => part.id));
    const outsideCollection = (titles ?? []).filter((title) => title.type !== "movie" || !partIds.has(Number(title.tmdb_id)));
    if (outsideCollection.length) throw new Error("Selected title list no longer matches the TMDB collection");
    posterPath = details.poster_path ?? null;
    backdropPath = details.backdrop_path ?? null;
  }

  for (const title of (titles ?? []).slice(0, 5)) {
    if (posterPath && backdropPath) break;
    try {
      const type = title.type === "tv_show" ? "tv" : "movie";
      const details = await tmdb(`/${type}/${title.tmdb_id}`) as {
        poster_path?: string | null;
        backdrop_path?: string | null;
      };
      posterPath ??= details.poster_path ?? null;
      backdropPath ??= details.backdrop_path ?? null;
    } catch { /* try another selected title for artwork */ }
  }

  const toImageUrl = (size: "w500" | "w1280", path: string | null) =>
    path && path.startsWith("/") ? `https://image.tmdb.org/t/p/${size}${path}` : null;
  const posterUrl = toImageUrl("w500", posterPath);
  const backdropUrl = toImageUrl("w1280", backdropPath);
  if (!posterUrl || !backdropUrl) throw new Error("TMDB did not provide both a poster and backdrop; no collection was created");

  const created = await executeTool("manage_collection", {
    action: "create",
    name: option.name,
    description: option.description,
    poster_url: posterUrl,
    backdrop_url: backdropUrl,
    is_public: true,
  }) as { collection?: { id: number; name: string; slug: string; description: string | null; is_public: boolean } };
  const collection = created.collection;
  if (!collection?.id) throw new Error("Collection could not be created");

  try {
    const added = await executeTool("manage_collection", {
      action: "add_items",
      collection_id: collection.id,
      content_ids: contentIds,
    }) as { added?: Array<{ id: number; title: string }> };
    return {
      collection,
      poster_url: posterUrl,
      backdrop_url: backdropUrl,
      added: added.added ?? [],
    };
  } catch (error) {
    await sb.from("collections_rels").delete().eq("parent_id", collection.id);
    await sb.from("collections").delete().eq("id", collection.id);
    throw error;
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handle(request: Request) {
  const { checkSecret } = await import("@/lib/engine.server");

  let body: z.infer<typeof Body>;
  try { body = Body.parse(await request.json()); }
  catch { return Response.json({ error: "Invalid request body" }, { status: 400 }); }

  if (!checkSecret(body.key)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (body.selected_collection_option) {
    try {
      const created = await createSelectedCollection(body.selected_collection_option);
      return Response.json({
        role: "assistant",
        content: `Created the OnFlix collection "${created.collection.name}" with ${created.added.length} published title(s).`,
        collection_created: created,
      });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  const hasAnyKey = PROVIDERS.some((p) => Boolean(p.getKey()?.trim()));
  if (!hasAnyKey) {
    return Response.json({ error: "No AI provider keys (GROQ_API_KEY, GITHUB_TOKEN, OPENROUTER_API_KEY) configured" }, { status: 503 });
  }

  const SYSTEM_PROMPT = buildCopilotSystemPrompt();

  // Keep only the last 8 messages to prevent token accumulation and TPM 429
  const recentMessages = body.messages.slice(-8);

  const groqMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...recentMessages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    })),
  ];

  let collectionOptions: unknown[] | undefined;

  // Agentic loop — up to 6 rounds to handle chained tool calls
  for (let round = 0; round < 6; round++) {
    let groqData: ProviderChatResponse;
    try {
      groqData = await callAIWithFailover(groqMessages, TOOLS);
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 429 });
    }

    const choice = groqData.choices[0];
    if (!choice) return Response.json({ error: "No response from AI provider" }, { status: 502 });

    const assistantMsg = choice.message;
    groqMessages.push(assistantMsg as typeof groqMessages[number]);

    // If no tool calls or done, return final message
    if (!assistantMsg.tool_calls?.length || choice.finish_reason === "stop") {
      return Response.json({
        role: "assistant",
        content: assistantMsg.content ?? "",
        tool_results: [],
        ...(collectionOptions ? { collection_options: collectionOptions } : {}),
      });
    }

    // Execute all tool calls in parallel
    const toolResults = await Promise.all(
      assistantMsg.tool_calls.map(async (tc) => {
        let result: unknown;
        let isError = false;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          result = await executeTool(tc.function.name, args);
        } catch (err) {
          result = { error: (err as Error).message };
          isError = true;
        }
        return {
          tool_call_id: tc.id,
          name: tc.function.name,
          result,
          isError,
        };
      }),
    );

    for (const result of toolResults) {
      if (result.name === "present_collection_options" && !result.isError) {
        const data = result.result as { options?: unknown[] };
        if (Array.isArray(data.options)) collectionOptions = data.options;
      }
    }

    // Add tool results to message history
    for (const tr of toolResults) {
      groqMessages.push({
        role: "tool",
        tool_call_id: tr.tool_call_id,
        content: JSON.stringify(tr.result),
      } as typeof groqMessages[number]);
    }

    // If last round, return current state
    if (round === 5) {
      return Response.json({
        role: "assistant",
        content: "Tool execution limit reached.",
        tool_results: toolResults,
        ...(collectionOptions ? { collection_options: collectionOptions } : {}),
      });
    }
  }

  return Response.json({ error: "Unexpected end of agentic loop" }, { status: 500 });
}

export const Route = createFileRoute("/api/public/copilot/chat")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
