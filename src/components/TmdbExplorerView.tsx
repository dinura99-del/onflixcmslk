import React, { useState, useEffect, useCallback } from "react";
import {
  Search, Copy, Check, Film, Tv, Star, Play, TrendingUp,
  Calendar, RefreshCw, Key, Filter, Globe, MapPin, X, ChevronDown,
  Maximize2, Clock
} from "lucide-react";
import { searchTmdbTitles, getTmdbConfig, trackForAutomation } from "@/lib/admin.functions";

export type TmdbItem = {
  id: number;
  title: string;
  mediaType: "movie" | "tv";
  releaseDate: string | null;
  year: string | null;
  voteAverage: number;
  voteCount: number;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  popularity: number;
};

type Props = {
  k: string;
  onSelectForProcess?: (target: { tmdbId: number; mediaType: "movie" | "tv"; title: string }) => void;
};

const DEFAULT_TMDB_API_KEY = "32338871e211188ebf5597d6a3fe0bc5";

const GENRES = [
  { id: "all", label: "All Genres", movieGid: undefined, tvGid: undefined },
  { id: "action", label: "Action & Adventure", movieGid: 28, tvGid: 10759 },
  { id: "animation", label: "Animation", movieGid: 16, tvGid: 16 },
  { id: "comedy", label: "Comedy", movieGid: 35, tvGid: 35 },
  { id: "crime", label: "Crime", movieGid: 80, tvGid: 80 },
  { id: "documentary", label: "Documentary", movieGid: 99, tvGid: 99 },
  { id: "drama", label: "Drama", movieGid: 18, tvGid: 18 },
  { id: "family", label: "Family", movieGid: 10751, tvGid: 10751 },
  { id: "fantasy", label: "Sci-Fi & Fantasy", movieGid: 878, tvGid: 10765 },
  { id: "horror", label: "Horror", movieGid: 27, tvGid: 9648 },
  { id: "mystery", label: "Mystery", movieGid: 9648, tvGid: 9648 },
  { id: "romance", label: "Romance", movieGid: 10749, tvGid: 10749 },
  { id: "thriller", label: "Thriller", movieGid: 53, tvGid: 9648 },
];

const LANGUAGES = [
  { code: "all", label: "All Languages" },
  { code: "en", label: "English" },
  { code: "ko", label: "Korean (한국어)" },
  { code: "ja", label: "Japanese (日本語)" },
  { code: "hi", label: "Hindi (हिन्दी)" },
  { code: "ta", label: "Tamil (தமிழ்)" },
  { code: "ml", label: "Malayalam (മലയാളം)" },
  { code: "te", label: "Telugu (తెలుగు)" },
  { code: "es", label: "Spanish (Español)" },
  { code: "fr", label: "French (Français)" },
  { code: "de", label: "German (Deutsch)" },
  { code: "zh", label: "Chinese (中文)" },
  { code: "tr", label: "Turkish (Türkçe)" },
  { code: "si", label: "Sinhala (සිංහල)" },
];

const COUNTRIES = [
  { code: "all", label: "All Countries" },
  { code: "US", label: "United States (US)" },
  { code: "KR", label: "South Korea (KR)" },
  { code: "JP", label: "Japan (JP)" },
  { code: "IN", label: "India (IN)" },
  { code: "GB", label: "United Kingdom (GB)" },
  { code: "FR", label: "France (FR)" },
  { code: "DE", label: "Germany (DE)" },
  { code: "ES", label: "Spain (ES)" },
  { code: "TR", label: "Turkey (TR)" },
  { code: "LK", label: "Sri Lanka (LK)" },
  { code: "CA", label: "Canada (CA)" },
  { code: "AU", label: "Australia (AU)" },
];

// Generate years from 2026 down to 1980
const YEARS = ["all", ...Array.from({ length: 47 }, (_, i) => String(2026 - i))];

function mapTmdbResults(results: any[]): TmdbItem[] {
  return (results || [])
    .filter((item: any) => {
      if (!item?.id) return false;
      const type = item.media_type || (item.title ? "movie" : "tv");
      return type === "movie" || type === "tv";
    })
    .map((item: any) => {
      const type = item.media_type || (item.title ? "movie" : "tv");
      const title = item.title || item.name || "Untitled";
      const date = item.release_date || item.first_air_date || null;
      const year = date ? String(date).slice(0, 4) : null;
      const poster = item.poster_path ? `https://image.tmdb.org/t/p/w780${item.poster_path}` : null;
      const backdrop = item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null;

      return {
        id: Number(item.id),
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
}

export function TmdbExplorerView({ k, onSelectForProcess }: Props) {
  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("onflix_tmdb_api_key") || DEFAULT_TMDB_API_KEY;
    }
    return DEFAULT_TMDB_API_KEY;
  });
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [query, setQuery] = useState("");
  const [mediaType, setMediaType] = useState<"all" | "movie" | "tv">("all");
  const [filterMode, setFilterMode] = useState<"search" | "trending" | "upcoming" | "top_rated">("top_rated");
  const [language, setLanguage] = useState<string>("all");
  const [genre, setGenre] = useState<string>("all");
  const [country, setCountry] = useState<string>("all");
  const [year, setYear] = useState<string>("all");
  const [results, setResults] = useState<TmdbItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // Poster Modal preview state
  const [previewItem, setPreviewItem] = useState<TmdbItem | null>(null);

  // Automation queue tracking state
  const [trackingId, setTrackingId] = useState<number | null>(null);
  const [trackedInfo, setTrackedInfo] = useState<Record<number, { isUpcoming: boolean; date?: string }>>({});
  const [trackNotification, setTrackNotification] = useState<string | null>(null);

  const handleTrack = async (item: TmdbItem) => {
    setTrackingId(item.id);
    setTrackNotification(null);
    try {
      const res = await trackForAutomation({
        data: {
          key: k,
          tmdbId: item.id,
          mediaType: item.mediaType,
        },
      });
      setTrackedInfo((prev) => ({
        ...prev,
        [item.id]: { isUpcoming: res.isUpcoming, date: res.releaseDate ?? undefined },
      }));
      if (res.isUpcoming) {
        setTrackNotification(`✓ Added "${item.title}" to Upcoming Queue! (Release Date: ${res.releaseDate}). Cron job will automatically process on release.`);
      } else {
        setTrackNotification(`✓ Added "${item.title}" to Live Queue! (Waiting for Video). Cron job will check automatically.`);
      }
    } catch (err) {
      setTrackNotification(`✗ ${(err as Error).message}`);
    } finally {
      setTrackingId(null);
    }
  };

  // Sync server key if available
  useEffect(() => {
    let active = true;
    getTmdbConfig({ data: { key: k } })
      .then((cfg) => {
        if (active && cfg?.apiKey && !localStorage.getItem("onflix_tmdb_api_key")) {
          setApiKey(cfg.apiKey);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [k]);

  // Close modal on escape
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewItem(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const hasActiveFilters = language !== "all" || genre !== "all" || country !== "all" || year !== "all";

  const fetchTitles = useCallback(async () => {
    setLoading(true);
    setErr("");
    const q = query.trim();

    try {
      const activeKey = apiKey.trim() || DEFAULT_TMDB_API_KEY;
      const isBearer = activeKey.length > 40;

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (isBearer) {
        headers["Authorization"] = `Bearer ${activeKey}`;
      }

      const buildUrl = (endpoint: string, extraParams: Record<string, string> = {}) => {
        const u = new URL(`https://api.themoviedb.org/3${endpoint}`);
        if (!isBearer) u.searchParams.set("api_key", activeKey);
        u.searchParams.set("page", "1");
        for (const [pk, pv] of Object.entries(extraParams)) {
          if (pv) u.searchParams.set(pk, pv);
        }
        return u.toString();
      };

      // 1. Direct Client-Side browser fetch
      try {
        if (q) {
          // Direct Search
          const endpoint = mediaType === "movie" ? "/search/movie" : mediaType === "tv" ? "/search/tv" : "/search/multi";
          const res = await fetch(buildUrl(endpoint, { query: q }), { headers });
          if (!res.ok) throw new Error(`HTTP ${res.status} from TMDB`);
          const data = await res.json();
          setResults(mapTmdbResults(data.results || []));
          return;
        }

        // Top Rated / Discover with Language, Genre, Country & Year filters
        const genreObj = GENRES.find((g) => g.id === genre);
        const useDiscover = filterMode === "top_rated" || hasActiveFilters;

        if (useDiscover) {
          const fetchDiscoverForType = async (type: "movie" | "tv") => {
            const params: Record<string, string> = {
              sort_by: "vote_average.desc",
              "vote_count.gte": type === "tv" ? "80" : "150",
            };

            if (language !== "all") params["with_original_language"] = language;
            if (country !== "all") params["with_origin_country"] = country;
            if (year !== "all") {
              if (type === "tv") {
                params["first_air_date_year"] = year;
              } else {
                params["primary_release_year"] = year;
              }
            }

            const gid = type === "movie" ? genreObj?.movieGid : genreObj?.tvGid;
            if (gid) params["with_genres"] = String(gid);

            const res = await fetch(buildUrl(`/discover/${type}`, params), { headers });
            if (!res.ok) throw new Error(`HTTP ${res.status} from TMDB`);
            const data = await res.json();
            return (data.results || []).map((item: any) => ({ ...item, media_type: type }));
          };

          if (mediaType === "movie") {
            const items = await fetchDiscoverForType("movie");
            setResults(mapTmdbResults(items));
          } else if (mediaType === "tv") {
            const items = await fetchDiscoverForType("tv");
            setResults(mapTmdbResults(items));
          } else {
            // Concurrent fetch both movies & TV series
            const [mItems, tItems] = await Promise.all([
              fetchDiscoverForType("movie"),
              fetchDiscoverForType("tv"),
            ]);
            const merged = [...mItems, ...tItems].sort(
              (a, b) => (b.vote_average || 0) - (a.vote_average || 0)
            );
            setResults(mapTmdbResults(merged));
          }
          return;
        }

        if (filterMode === "trending") {
          const endpoint = mediaType === "all" ? "/trending/all/day" : `/trending/${mediaType}/day`;
          const res = await fetch(buildUrl(endpoint), { headers });
          if (!res.ok) throw new Error(`HTTP ${res.status} from TMDB`);
          const data = await res.json();
          setResults(mapTmdbResults(data.results || []));
          return;
        }

        if (filterMode === "upcoming") {
          const res = await fetch(buildUrl("/movie/upcoming"), { headers });
          if (!res.ok) throw new Error(`HTTP ${res.status} from TMDB`);
          const data = await res.json();
          setResults(mapTmdbResults(data.results || []));
          return;
        }
      } catch (clientFetchErr) {
        // Fallback to server function if direct browser fetch hits a network block
        console.warn("Client fetch to TMDB hit error, trying server fallback:", clientFetchErr);
        const serverRes = await searchTmdbTitles({
          data: {
            key: k,
            query: q,
            mediaType,
            page: 1,
            filter: q ? "search" : filterMode,
            language,
            genre,
            country,
            year,
          },
        });
        setResults(serverRes as TmdbItem[]);
      }
    } catch (e) {
      setErr((e as Error).message || "Could not fetch titles from TMDB. Please check your connection.");
    } finally {
      setLoading(false);
    }
  }, [k, apiKey, query, mediaType, filterMode, language, genre, country, year, hasActiveFilters]);

  useEffect(() => {
    const timer = setTimeout(fetchTitles, 300);
    return () => clearTimeout(timer);
  }, [fetchTitles]);

  const copyTmdbId = async (id: number) => {
    try {
      await navigator.clipboard.writeText(String(id));
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2500);
    } catch {
      // fallback
    }
  };

  const resetAllFilters = () => {
    setLanguage("all");
    setGenre("all");
    setCountry("all");
    setYear("all");
    setQuery("");
  };

  const saveCustomKey = (newKey: string) => {
    const trimmed = newKey.trim();
    if (trimmed) {
      localStorage.setItem("onflix_tmdb_api_key", trimmed);
      setApiKey(trimmed);
    } else {
      localStorage.removeItem("onflix_tmdb_api_key");
      setApiKey(DEFAULT_TMDB_API_KEY);
    }
    setShowKeyInput(false);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-semibold tracking-tight">TMDB Explorer & ID Lookup</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Click any movie or series to preview its full poster and overview. 1-click copy IDs or dispatch to automation.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={() => setShowKeyInput(!showKeyInput)}
            className="flex items-center gap-1.5 rounded-xl bg-secondary px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors cursor-pointer"
            title="Configure TMDB API Key"
          >
            <Key className="size-3.5" />
            <span className="hidden sm:inline">API Key</span>
          </button>

          <button
            onClick={fetchTitles}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-xl bg-secondary px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Optional TMDB API Key settings row */}
      {showKeyInput && (
        <div className="rounded-2xl bg-card p-4 space-y-2 animate-in fade-in duration-200">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">Custom TMDB API Key / Token</span>
            <span className="text-[11px] text-muted-foreground">Stored in local browser storage</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="password"
              defaultValue={apiKey}
              id="customTmdbKeyInput"
              placeholder="Paste TMDB v3 API Key or v4 Read Access Token…"
              className="flex-1 rounded-xl bg-background/60 px-3.5 py-2 text-xs outline-none focus:bg-background transition-colors"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const input = document.getElementById("customTmdbKeyInput") as HTMLInputElement;
                  if (input) saveCustomKey(input.value);
                }}
                className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-black cursor-pointer hover:opacity-90"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  saveCustomKey("");
                }}
                className="rounded-xl bg-secondary px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer"
              >
                Reset Default
              </button>
            </div>
          </div>
        </div>
      )}

      {err && (
        <div className="rounded-2xl bg-destructive/10 p-4 text-xs text-destructive flex items-center justify-between gap-3">
          <span>{err}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={fetchTitles}
              className="rounded-lg bg-destructive/20 px-2.5 py-1 text-xs font-semibold text-destructive hover:bg-destructive/30 cursor-pointer"
            >
              Retry
            </button>
            <button onClick={() => setErr("")} className="font-semibold underline cursor-pointer">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Search Bar & Filters Card */}
      <div className="rounded-2xl bg-card p-3.5 sm:p-5 space-y-3">
        {/* Row 1: Search + Media Type Selector */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (e.target.value.trim()) {
                  setFilterMode("search");
                }
              }}
              placeholder="Search by title"
              className="w-full rounded-xl bg-background/60 pl-10 pr-9 py-2.5 text-xs sm:text-sm outline-none focus:bg-background transition-colors"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setFilterMode("top_rated");
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>

          {/* Media Type Tabs */}
          <div className="flex overflow-x-auto no-scrollbar gap-1 rounded-xl bg-background/60 p-1 shrink-0">
            {(["all", "movie", "tv"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setMediaType(t)}
                className={`flex-1 sm:flex-initial rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer capitalize ${
                  mediaType === t
                    ? "bg-secondary text-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "all" ? "All Media" : t === "movie" ? "Movies" : "TV Series"}
              </button>
            ))}
          </div>
        </div>

        {/* Row 2: Discovery Mode Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar text-xs">
          <button
            onClick={() => {
              setQuery("");
              setFilterMode("top_rated");
            }}
            className={`whitespace-nowrap flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 font-medium transition-colors cursor-pointer text-xs ${
              !query && filterMode === "top_rated"
                ? "bg-primary/20 text-primary font-semibold"
                : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
            }`}
          >
          
            <span>Top Rated</span>
          </button>

          <button
            onClick={() => {
              setQuery("");
              setFilterMode("trending");
            }}
            className={`whitespace-nowrap flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 font-medium transition-colors cursor-pointer text-xs ${
              !query && filterMode === "trending"
                ? "bg-primary/20 text-primary font-semibold"
                : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
            }`}
          >
          
            <span>Trending Today</span>
          </button>

          <button
            onClick={() => {
              setQuery("");
              setFilterMode("upcoming");
            }}
            className={`whitespace-nowrap flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 font-medium transition-colors cursor-pointer text-xs ${
              !query && filterMode === "upcoming"
                ? "bg-primary/20 text-primary font-semibold"
                : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
            }`}
          >
          
            <span>Upcoming Releases</span>
          </button>
        </div>

        {/* Row 3: Compact & Responsive 2x2 on Mobile, 4 columns on Desktop Filters */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-1">
          {/* Language Select */}
          <div className="space-y-1">
            <label className="text-[10px] sm:text-[11px] font-medium text-muted-foreground flex items-center gap-1">
             
              <span className="truncate">Language</span>
            </label>
            <div className="relative">
              <select
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  setFilterMode("top_rated");
                }}
                className="w-full appearance-none rounded-xl bg-background/60 pr-7 pl-2.5 py-2 text-xs text-foreground outline-none focus:bg-background transition-colors cursor-pointer truncate"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code} className="bg-card text-foreground">
                    {l.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            </div>
          </div>

          {/* Genre Select */}
          <div className="space-y-1">
            <label className="text-[10px] sm:text-[11px] font-medium text-muted-foreground flex items-center gap-1">
        
              <span className="truncate">Genre</span>
            </label>
            <div className="relative">
              <select
                value={genre}
                onChange={(e) => {
                  setGenre(e.target.value);
                  setFilterMode("top_rated");
                }}
                className="w-full appearance-none rounded-xl bg-background/60 pr-7 pl-2.5 py-2 text-xs text-foreground outline-none focus:bg-background transition-colors cursor-pointer truncate"
              >
                {GENRES.map((g) => (
                  <option key={g.id} value={g.id} className="bg-card text-foreground">
                    {g.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            </div>
          </div>

          {/* Country Select */}
          <div className="space-y-1">
            <label className="text-[10px] sm:text-[11px] font-medium text-muted-foreground flex items-center gap-1">
              
              <span className="truncate">Country</span>
            </label>
            <div className="relative">
              <select
                value={country}
                onChange={(e) => {
                  setCountry(e.target.value);
                  setFilterMode("top_rated");
                }}
                className="w-full appearance-none rounded-xl bg-background/60 pr-7 pl-2.5 py-2 text-xs text-foreground outline-none focus:bg-background transition-colors cursor-pointer truncate"
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code} className="bg-card text-foreground">
                    {c.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            </div>
          </div>

          {/* Year Select */}
          <div className="space-y-1">
            <label className="text-[10px] sm:text-[11px] font-medium text-muted-foreground flex items-center gap-1">
             
              <span className="truncate">Release Year</span>
            </label>
            <div className="relative">
              <select
                value={year}
                onChange={(e) => {
                  setYear(e.target.value);
                  setFilterMode("top_rated");
                }}
                className="w-full appearance-none rounded-xl bg-background/60 pr-7 pl-2.5 py-2 text-xs text-foreground outline-none focus:bg-background transition-colors cursor-pointer truncate"
              >
                <option value="all" className="bg-card text-foreground">All Years</option>
                {YEARS.filter((y) => y !== "all").map((y) => (
                  <option key={y} value={y} className="bg-card text-foreground">
                    {y}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            </div>
          </div>
        </div>

        {/* Row 4: Active Filter Badges */}
        {hasActiveFilters && (
          <div className="flex items-center justify-between gap-2 pt-1 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-[11px] text-muted-foreground">Active:</span>
              {language !== "all" && (
                <button
                  onClick={() => setLanguage("all")}
                  className="inline-flex items-center gap-1 rounded-lg bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/25 cursor-pointer"
                  title="Remove Language Filter"
                >
                  <span>{LANGUAGES.find((l) => l.code === language)?.label.split(" ")[0]}</span>
                  <X className="size-2.5" />
                </button>
              )}
              {genre !== "all" && (
                <button
                  onClick={() => setGenre("all")}
                  className="inline-flex items-center gap-1 rounded-lg bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/25 cursor-pointer"
                  title="Remove Genre Filter"
                >
                  <span>{GENRES.find((g) => g.id === genre)?.label}</span>
                  <X className="size-2.5" />
                </button>
              )}
              {country !== "all" && (
                <button
                  onClick={() => setCountry("all")}
                  className="inline-flex items-center gap-1 rounded-lg bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/25 cursor-pointer"
                  title="Remove Country Filter"
                >
                  <span>{country}</span>
                  <X className="size-2.5" />
                </button>
              )}
              {year !== "all" && (
                <button
                  onClick={() => setYear("all")}
                  className="inline-flex items-center gap-1 rounded-lg bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/25 cursor-pointer"
                  title="Remove Year Filter"
                >
                  <span>{year}</span>
                  <X className="size-2.5" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={resetAllFilters}
              className="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer font-medium underline"
            >
              Clear All
            </button>
          </div>
        )}
      </div>

      {/* Notification Banner */}
      {trackNotification && (
        <div className="rounded-2xl bg-primary/10 border border-primary/20 p-3 text-xs text-primary flex items-center justify-between animate-in fade-in">
          <span>{trackNotification}</span>
          <button onClick={() => setTrackNotification(null)} className="opacity-70 hover:opacity-100 font-bold ml-2 cursor-pointer">✕</button>
        </div>
      )}

      {/* Results Count & Grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {loading ? "Discovering titles directly from TMDB…" : `${results.length} titles found`}
          </span>
          {copiedId && (
            <span className="font-semibold text-primary animate-in fade-in duration-200">
              Copied TMDB ID: {copiedId} to clipboard!
            </span>
          )}
        </div>

        {loading ? (
          <div className="py-20 text-center text-xs text-muted-foreground flex flex-col items-center gap-3">
            <RefreshCw className="size-5 animate-spin text-primary" />
            <span>Loading filtered titles directly from TMDB…</span>
          </div>
        ) : results.length === 0 ? (
          <div className="py-20 text-center text-xs text-muted-foreground rounded-2xl bg-card p-8 space-y-2">
            <p>No titles found matching the selected filters.</p>
            {hasActiveFilters && (
              <button
                onClick={resetAllFilters}
                className="rounded-xl bg-secondary px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary/80 cursor-pointer"
              >
                Reset Filters
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
            {results.map((item) => {
              const isMovie = item.mediaType === "movie";
              const isCopied = copiedId === item.id;

              return (
                <div
                  key={`${item.mediaType}-${item.id}`}
                  className="rounded-2xl bg-card p-3 flex flex-col justify-between transition-all hover:bg-card/85 group"
                >
                  <div className="space-y-2.5">
                    {/* Poster + Badges - Clickable to open full preview */}
                    <div
                      onClick={() => setPreviewItem(item)}
                      className="relative aspect-[16/10] sm:aspect-[16/9] w-full rounded-xl overflow-hidden bg-background/80 flex items-center justify-center cursor-pointer group-hover:opacity-95"
                    >
                      {item.backdropUrl || item.posterUrl ? (
                        <img
                          src={item.backdropUrl || item.posterUrl || ""}
                          alt={item.title}
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-muted-foreground">
                          {isMovie ? <Film className="size-8" /> : <Tv className="size-8" />}
                          <span className="text-[10px]">No Image</span>
                        </div>
                      )}

                      {/* Top Badges */}
                      <div className="absolute top-2 left-2 flex items-center gap-1.5">
                        <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          isMovie ? "bg-primary text-black" : "bg-purple-500 text-white"
                        }`}>
                          {item.mediaType}
                        </span>
                        {item.year && (
                          <span className="rounded-md bg-black/70 backdrop-blur-xs px-1.5 py-0.5 text-[10px] font-mono text-white">
                            {item.year}
                          </span>
                        )}
                      </div>

                      {/* Rating Badge */}
                      {item.voteAverage > 0 && (
                        <div className="absolute top-2 right-2 rounded-md bg-black/75 backdrop-blur-xs px-2 py-0.5 text-[10px] font-semibold text-warning flex items-center gap-1">
                          <Star className="size-3 fill-current" />
                          <span>{item.voteAverage}</span>
                        </div>
                      )}

                      {/* Hover Overlay preview hint */}
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                        <span className="flex items-center gap-1 text-[11px] font-medium text-white bg-black/60 px-2.5 py-1 rounded-lg backdrop-blur-xs">
                          <Maximize2 className="size-3" />
                          <span>View Poster</span>
                        </span>
                      </div>
                    </div>

                    {/* Title & TMDB ID - Clickable */}
                    <div
                      onClick={() => setPreviewItem(item)}
                      className="cursor-pointer"
                    >
                      <h4 className="text-sm font-semibold text-foreground line-clamp-1 group-hover:text-primary transition-colors" title={item.title}>
                        {item.title}
                      </h4>
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                        {item.overview || "No overview available."}
                      </p>
                    </div>
                  </div>

                  {/* Actions Bar */}
                  <div className="mt-3 pt-2 flex items-center justify-between gap-2">
                    {/* Copy TMDB ID Button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyTmdbId(item.id);
                      }}
                      className={`flex-1 flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-mono font-medium transition-all cursor-pointer ${
                        isCopied
                          ? "bg-success/20 text-success"
                          : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
                      }`}
                      title="Copy TMDB ID"
                    >
                      {isCopied ? (
                        <>
                          <Check className="size-3.5" />
                          <span>Copied!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="size-3.5" />
                          <span>ID: {item.id}</span>
                        </>
                      )}
                    </button>

                    {/* Track for Cron Automation Button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTrack(item);
                      }}
                      disabled={trackingId === item.id}
                      className="flex items-center gap-1 rounded-xl bg-secondary px-2.5 py-2 text-xs font-semibold text-foreground hover:bg-secondary/80 transition-all cursor-pointer disabled:opacity-50"
                      title="Add to Cron Queue for automatic release detection"
                    >
                      {trackedInfo[item.id] ? (
                        <>
                          <Check className="size-3 text-success" />
                          <span className="text-success text-[11px]">
                            {trackedInfo[item.id]?.isUpcoming ? "Upcoming" : "Queued"}
                          </span>
                        </>
                      ) : (
                        <>
                          <Clock className={`size-3 text-primary ${trackingId === item.id ? "animate-spin" : ""}`} />
                          <span className="text-[11px]">{trackingId === item.id ? "…" : "Auto"}</span>
                        </>
                      )}
                    </button>

                    {/* Send to Automation Button */}
                    {onSelectForProcess && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectForProcess({ tmdbId: item.id, mediaType: item.mediaType, title: item.title });
                        }}
                        className="flex items-center gap-1 rounded-xl bg-primary/15 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary hover:text-black transition-all cursor-pointer"
                        title="Open in Manual Process"
                      >
                        <Play className="size-3 fill-current" />
                        <span>Process</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Responsive Poster & Details Lightbox Modal */}
      {previewItem && (
        <div
          onClick={() => setPreviewItem(null)}
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md sm:max-w-2xl max-h-[90vh] overflow-y-auto no-scrollbar rounded-3xl bg-card p-4 sm:p-6 shadow-2xl animate-in zoom-in-95 duration-200 space-y-4"
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    previewItem.mediaType === "movie" ? "bg-primary text-black" : "bg-purple-500 text-white"
                  }`}>
                    {previewItem.mediaType}
                  </span>
                  {previewItem.year && (
                    <span className="text-xs text-muted-foreground font-mono">
                      {previewItem.year}
                    </span>
                  )}
                  {previewItem.voteAverage > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-warning">
                      <Star className="size-3.5 fill-current" />
                      <span>{previewItem.voteAverage}</span>
                      <span className="text-muted-foreground font-normal text-[11px]">
                        ({previewItem.voteCount.toLocaleString()} votes)
                      </span>
                    </span>
                  )}
                </div>
                <h3 className="text-base sm:text-xl font-bold text-foreground mt-1.5 leading-snug">
                  {previewItem.title}
                </h3>
              </div>

              <button
                type="button"
                onClick={() => setPreviewItem(null)}
                className="rounded-xl bg-secondary p-2 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                title="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Poster / Backdrop Image display */}
            <div className="relative w-full overflow-hidden rounded-2xl bg-background/80 flex items-center justify-center">
              {previewItem.posterUrl || previewItem.backdropUrl ? (
                <img
                  src={previewItem.posterUrl || previewItem.backdropUrl || ""}
                  alt={previewItem.title}
                  className="w-full max-h-[50vh] sm:max-h-[55vh] object-contain rounded-2xl bg-black/40"
                />
              ) : (
                <div className="py-24 text-muted-foreground text-xs">No poster available</div>
              )}
            </div>

            {/* Overview & Metadata */}
            <div className="space-y-3 pt-1">
              {previewItem.overview && (
                <div>
                  <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Overview
                  </h5>
                  <p className="mt-1 text-xs sm:text-sm text-foreground/90 leading-relaxed max-h-36 overflow-y-auto no-scrollbar">
                    {previewItem.overview}
                  </p>
                </div>
              )}

              {/* Action Buttons in Modal */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => copyTmdbId(previewItem.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-mono font-medium transition-all cursor-pointer ${
                    copiedId === previewItem.id
                      ? "bg-success/20 text-success"
                      : "bg-secondary text-foreground hover:bg-secondary/80"
                  }`}
                >
                  {copiedId === previewItem.id ? (
                    <>
                      <Check className="size-4" />
                      <span>Copied TMDB ID: {previewItem.id}!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="size-4" />
                      <span>Copy TMDB ID ({previewItem.id})</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => handleTrack(previewItem)}
                  disabled={trackingId === previewItem.id}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-secondary px-4 py-2.5 text-xs font-semibold text-foreground hover:bg-secondary/80 transition-all cursor-pointer disabled:opacity-50"
                >
                  <Clock className={`size-3.5 text-primary ${trackingId === previewItem.id ? "animate-spin" : ""}`} />
                  <span>
                    {trackedInfo[previewItem.id]
                      ? trackedInfo[previewItem.id]?.isUpcoming
                        ? `Tracked (Release: ${trackedInfo[previewItem.id]?.date ?? "Upcoming"})`
                        : "Tracked in Live Queue"
                      : trackingId === previewItem.id
                      ? "Queueing…"
                      : "Track for Cron"}
                  </span>
                </button>

                {onSelectForProcess && (
                  <button
                    type="button"
                    onClick={() => {
                      onSelectForProcess({
                        tmdbId: previewItem.id,
                        mediaType: previewItem.mediaType,
                        title: previewItem.title,
                      });
                      setPreviewItem(null);
                    }}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-xs font-semibold text-black hover:opacity-90 transition-all cursor-pointer"
                  >
                    <Play className="size-3.5 fill-current" />
                    <span>Process Now</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
