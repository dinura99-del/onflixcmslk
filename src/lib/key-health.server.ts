import { geminiKeys } from "./gemini-polish.server";
import { subdlKeys } from "./engine.server";

export type KeyHealthStatus = "healthy" | "rate_limited" | "invalid" | "timeout" | "unconfigured" | "error";

export type ApiKeyInfo = {
  id: string;
  envVar: string;
  provider: "gemini" | "groq" | "subdl" | "tmdb" | "wyzie" | "github" | "openrouter" | "mymemory";
  providerName: string;
  role: string;
  keyMasked: string;
  status: KeyHealthStatus;
  statusCode?: number | undefined;
  latencyMs?: number | undefined;
  rateLimits: {
    rpm: string;
    rpd: string;
    tpm?: string | undefined;
    tier: string;
  };
  error?: string | undefined;
  checkedAt: string;
};

export type KeyPoolHealthReport = {
  totalKeys: number;
  healthyKeys: number;
  poolHealthPercent: number;
  avgLatencyMs: number;
  geminiPool: {
    totalWorkers: number;
    healthyWorkers: number;
    combinedRpm: number;
    combinedRpd: number;
    combinedTpm: string;
  };
  keys: ApiKeyInfo[];
  checkedAt: string;
};

export function maskKey(raw: string | undefined | null): string {
  if (!raw) return "Not configured";
  const str = String(raw).trim();
  if (str.length <= 8) return "••••••••";
  return `${str.slice(0, 6)}••••${str.slice(-4)}`;
}

async function pingWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 8000
): Promise<{ ok: boolean; status: number; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    const isTimeout = (err as Error).name === "TimeoutError" || /timeout/i.test((err as Error).message);
    return {
      ok: false,
      status: isTimeout ? 408 : 0,
      latencyMs: Date.now() - t0,
      error: isTimeout ? "Request timed out (>8s)" : (err as Error).message,
    };
  }
}

async function testGeminiKey(key: string, envVar: string, index: number): Promise<ApiKeyInfo> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const ping = await pingWithTimeout(url, {}, 8000);

  let status: KeyHealthStatus = "healthy";
  if (!ping.ok) {
    if (ping.status === 429) status = "rate_limited";
    else if (ping.status === 400 || ping.status === 403) status = "invalid";
    else if (ping.status === 408) status = "timeout";
    else status = "error";
  }

  return {
    id: `gemini_${index}`,
    envVar,
    provider: "gemini",
    providerName: "Google Gemini Flash",
    role: `Subtitle Polish Worker #${index + 1}`,
    keyMasked: maskKey(key),
    status,
    statusCode: ping.status,
    latencyMs: ping.latencyMs,
    rateLimits: {
      rpm: "15 RPM",
      rpd: "1,500 RPD",
      tpm: "1,000,000 TPM",
      tier: "Free Tier Quota",
    },
    error: ping.error,
    checkedAt: new Date().toISOString(),
  };
}

async function testGroqKey(key: string): Promise<ApiKeyInfo> {
  const url = "https://api.groq.com/openai/v1/models";
  const ping = await pingWithTimeout(url, { headers: { Authorization: `Bearer ${key}` } }, 7000);

  let status: KeyHealthStatus = "healthy";
  if (!ping.ok) {
    if (ping.status === 429) status = "rate_limited";
    else if (ping.status === 401 || ping.status === 403) status = "invalid";
    else if (ping.status === 408) status = "timeout";
    else status = "error";
  }

  return {
    id: "groq",
    envVar: "GROQ_API_KEY",
    provider: "groq",
    providerName: "Groq Cloud (LPU)",
    role: "AI Co-Pilot LLM Provider",
    keyMasked: maskKey(key),
    status,
    statusCode: ping.status,
    latencyMs: ping.latencyMs,
    rateLimits: {
      rpm: "30 RPM",
      rpd: "14,400 RPD",
      tpm: "6,000 TPM",
      tier: "On-demand Free Tier",
    },
    error: ping.error,
    checkedAt: new Date().toISOString(),
  };
}

async function testTmdbKey(key: string): Promise<ApiKeyInfo> {
  const isBearer = key.length > 40;
  const url = isBearer
    ? "https://api.themoviedb.org/3/configuration"
    : `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`;
  const headers = isBearer ? { Authorization: `Bearer ${key}` } : {};

  const ping = await pingWithTimeout(url, { headers }, 7000);

  let status: KeyHealthStatus = "healthy";
  if (!ping.ok) {
    if (ping.status === 429) status = "rate_limited";
    else if (ping.status === 401 || ping.status === 404) status = "invalid";
    else if (ping.status === 408) status = "timeout";
    else status = "error";
  }

  return {
    id: "tmdb",
    envVar: "TMDB_API_KEY",
    provider: "tmdb",
    providerName: "The Movie Database (TMDB)",
    role: "Movies & TV Metadata, Posters & Season Info",
    keyMasked: maskKey(key),
    status,
    statusCode: ping.status,
    latencyMs: ping.latencyMs,
    rateLimits: {
      rpm: "~2,400 RPM",
      rpd: "Unlimited",
      tier: "API Developer Tier (40 req/s)",
    },
    error: ping.error,
    checkedAt: new Date().toISOString(),
  };
}

async function testSubdlKey(key: string, envVar: string, index: number): Promise<ApiKeyInfo> {
  const url = `https://api.subdl.com/api/v1/subtitles?api_key=${encodeURIComponent(key)}&film_name=Inception`;
  const ping = await pingWithTimeout(url, {}, 8000);

  let status: KeyHealthStatus = "healthy";
  if (!ping.ok) {
    if (ping.status === 429) status = "rate_limited";
    else if (ping.status === 401 || ping.status === 403) status = "invalid";
    else if (ping.status === 408) status = "timeout";
    else status = "error";
  }

  return {
    id: `subdl_${index}`,
    envVar,
    provider: "subdl",
    providerName: "SubDL Subtitles API",
    role: index === 0 ? "Primary English Subtitle Downloader" : `Backup SubDL Key #${index + 1}`,
    keyMasked: maskKey(key),
    status,
    statusCode: ping.status,
    latencyMs: ping.latencyMs,
    rateLimits: {
      rpm: "60 RPM",
      rpd: "1,000 RPD",
      tier: "Standard API Plan",
    },
    error: ping.error,
    checkedAt: new Date().toISOString(),
  };
}

export async function runApiKeysHealthAudit(): Promise<KeyPoolHealthReport> {
  const env = process.env;
  const promises: Promise<ApiKeyInfo>[] = [];

  // 1. Collect all Gemini Multi-Key Pool keys
  const geminiEnvVars = Object.keys(env)
    .filter((n) => /^GEMINI_(?:API_)?KEY(?:_\w+)?$/i.test(n))
    .sort((a, b) => {
      const aIsMain = /^GEMINI_(?:API_)?KEY$/i.test(a);
      const bIsMain = /^GEMINI_(?:API_)?KEY$/i.test(b);
      if (aIsMain && !bIsMain) return -1;
      if (!aIsMain && bIsMain) return 1;
      const numA = Number(a.split("_").pop());
      const numB = Number(b.split("_").pop());
      if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB;
      return a.localeCompare(b);
    });

  const uniqueGeminiKeys = new Map<string, string>(); // key -> envVar
  geminiEnvVars.forEach((v) => {
    const val = (env[v] || "").trim();
    if (val && !uniqueGeminiKeys.has(val)) {
      uniqueGeminiKeys.set(val, v);
    }
  });

  Array.from(uniqueGeminiKeys.entries()).forEach(([key, envVar], idx) => {
    promises.push(testGeminiKey(key, envVar, idx));
  });

  // 2. Groq Key
  const groq = env["GROQ_API_KEY"]?.trim();
  if (groq) {
    promises.push(testGroqKey(groq));
  } else {
    promises.push(
      Promise.resolve({
        id: "groq",
        envVar: "GROQ_API_KEY",
        provider: "groq",
        providerName: "Groq Cloud (LPU)",
        role: "AI Co-Pilot LLM Provider",
        keyMasked: "Not configured",
        status: "unconfigured",
        rateLimits: { rpm: "30 RPM", rpd: "14,400 RPD", tier: "Free Tier" },
        checkedAt: new Date().toISOString(),
      })
    );
  }

  // 3. TMDB Key
  const tmdb = env["TMDB_API_KEY"]?.trim();
  if (tmdb) {
    promises.push(testTmdbKey(tmdb));
  } else {
    promises.push(
      Promise.resolve({
        id: "tmdb",
        envVar: "TMDB_API_KEY",
        provider: "tmdb",
        providerName: "The Movie Database (TMDB)",
        role: "Movies & TV Metadata, Posters & Season Info",
        keyMasked: "Not configured",
        status: "unconfigured",
        rateLimits: { rpm: "2,400 RPM", rpd: "Unlimited", tier: "API Developer" },
        checkedAt: new Date().toISOString(),
      })
    );
  }

  // 4. SubDL Keys
  const subdlList = subdlKeys();
  if (subdlList.length > 0) {
    subdlList.forEach((key, idx) => {
      promises.push(testSubdlKey(key, idx === 0 ? "SUBDL_API_KEY" : `SUBDL_API_KEY_${idx + 1}`, idx));
    });
  } else {
    promises.push(
      Promise.resolve({
        id: "subdl_0",
        envVar: "SUBDL_API_KEY",
        provider: "subdl",
        providerName: "SubDL Subtitles API",
        role: "Primary English Subtitle Downloader",
        keyMasked: "Not configured",
        status: "unconfigured",
        rateLimits: { rpm: "60 RPM", rpd: "1,000 RPD", tier: "Standard API" },
        checkedAt: new Date().toISOString(),
      })
    );
  }

  // Execute all checks in parallel
  const settled = await Promise.allSettled(promises);
  const keys: ApiKeyInfo[] = settled.map((s, idx) => {
    if (s.status === "fulfilled") return s.value;
    return {
      id: `err_${idx}`,
      envVar: "UNKNOWN",
      provider: "gemini",
      providerName: "Service Check Failed",
      role: "Unknown",
      keyMasked: "••••••••",
      status: "error",
      error: s.reason?.message || "Check failed",
      rateLimits: { rpm: "N/A", rpd: "N/A", tier: "N/A" },
      checkedAt: new Date().toISOString(),
    };
  });

  const configuredKeys = keys.filter((k) => k.status !== "unconfigured");
  const healthyKeys = keys.filter((k) => k.status === "healthy");
  const geminiKeysList = keys.filter((k) => k.provider === "gemini");
  const healthyGemini = geminiKeysList.filter((k) => k.status === "healthy");

  const latencies = keys.filter((k) => typeof k.latencyMs === "number" && k.latencyMs > 0).map((k) => k.latencyMs!);
  const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  return {
    totalKeys: configuredKeys.length,
    healthyKeys: healthyKeys.length,
    poolHealthPercent: configuredKeys.length > 0 ? Math.round((healthyKeys.length / configuredKeys.length) * 100) : 0,
    avgLatencyMs: avgLatency,
    geminiPool: {
      totalWorkers: geminiKeysList.length,
      healthyWorkers: healthyGemini.length,
      combinedRpm: geminiKeysList.length * 15,
      combinedRpd: geminiKeysList.length * 1500,
      combinedTpm: `${geminiKeysList.length}M TPM`,
    },
    keys,
    checkedAt: new Date().toISOString(),
  };
}
