import React, { useState, useEffect, useCallback } from "react";
import {
  Activity, ShieldCheck, RefreshCw, Key, Cpu, Zap, AlertTriangle,
  CheckCircle2, XCircle, Clock, Copy, Check, Database, Sparkles,
  Server, Layers, ArrowUpRight
} from "lucide-react";
import { getApiKeysHealthReport } from "@/lib/admin.functions";
import type { KeyPoolHealthReport, ApiKeyInfo, KeyHealthStatus } from "@/lib/key-health.server";

export function KeyHealthDashboardView({ k }: { k: string }) {
  const [data, setData] = useState<KeyPoolHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<string>("all");

  const runAudit = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await getApiKeysHealthReport({ data: { key: k } });
      setData(res as KeyPoolHealthReport);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [k]);

  useEffect(() => {
    runAudit();
  }, [runAudit]);

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKeyId(id);
      setTimeout(() => setCopiedKeyId(null), 2500);
    } catch {
      // fallback
    }
  };

  const filteredKeys = (data?.keys || []).filter((item) => {
    if (providerFilter === "all") return true;
    return item.provider === providerFilter;
  });

  const geminiWorkers = (data?.keys || []).filter((item) => item.provider === "gemini");

  const getStatusBadge = (status: KeyHealthStatus, statusCode?: number) => {
    switch (status) {
      case "healthy":
        return {
          label: statusCode ? `${statusCode} OK` : "Healthy",
          cls: "bg-success/15 text-success",
          dot: "bg-success",
        };
      case "rate_limited":
        return {
          label: "429 Rate Limited",
          cls: "bg-warning/20 text-warning",
          dot: "bg-warning",
        };
      case "invalid":
        return {
          label: statusCode ? `${statusCode} Unauthorized` : "Invalid Key",
          cls: "bg-destructive/20 text-destructive",
          dot: "bg-destructive",
        };
      case "timeout":
        return {
          label: "Timeout (>8s)",
          cls: "bg-orange-500/20 text-orange-400",
          dot: "bg-orange-500",
        };
      case "unconfigured":
        return {
          label: "Not Configured",
          cls: "bg-muted text-muted-foreground",
          dot: "bg-muted-foreground",
        };
      default:
        return {
          label: "Error",
          cls: "bg-destructive/20 text-destructive",
          dot: "bg-destructive",
        };
    }
  };

  const getLatencyColor = (ms?: number) => {
    if (typeof ms !== "number") return "text-muted-foreground";
    if (ms < 800) return "text-success";
    if (ms < 2500) return "text-warning";
    return "text-destructive";
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg sm:text-xl font-semibold tracking-tight">Multi-API Key Health & Quota Dashboard</h2>
            <span className="rounded-lg bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
              Live Telemetry
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Real-time ping latency, rate limits & daily quota telemetry across Gemini multi-key pool, Groq, SubDL and TMDB.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          {data?.checkedAt && (
            <span className="text-[11px] text-muted-foreground hidden md:inline">
              Audited: {new Date(data.checkedAt).toLocaleTimeString()}
            </span>
          )}

          <button
            onClick={runAudit}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-xl bg-secondary px-3.5 py-2 text-xs font-medium text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin text-primary" : ""}`} />
            <span>{loading ? "Pinging Keys…" : "Run Health Audit"}</span>
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded-2xl bg-destructive/10 p-4 text-xs text-destructive flex items-center justify-between gap-3">
          <span>{err}</span>
          <button onClick={() => setErr("")} className="font-semibold underline cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {/* Top Telemetry KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {/* Pool Health */}
        <div className="rounded-2xl bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Key Pool Health</span>
            <div className="size-2 rounded-full bg-success animate-pulse" />
          </div>
          <div className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            {loading ? "…" : `${data?.healthyKeys ?? 0} / ${data?.totalKeys ?? 0}`}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <span className="font-semibold text-success">{loading ? "…" : `${data?.poolHealthPercent ?? 0}%`}</span>
            <span>operational</span>
          </div>
        </div>

        {/* Gemini Pool Scaling */}
        <div className="rounded-2xl bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Gemini REST Pool</span>
            <Cpu className="size-4 text-primary" />
          </div>
          <div className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            {loading ? "…" : `${data?.geminiPool.totalWorkers ?? 0} Workers`}
          </div>
          <div className="text-xs text-muted-foreground">
            Dynamic worker scaling active
          </div>
        </div>

        {/* Combined Daily Quota */}
        <div className="rounded-2xl bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Combined Daily Quota</span>
            <Zap className="size-4 text-warning" />
          </div>
          <div className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            {loading ? "…" : `${(data?.geminiPool.combinedRpd ?? 0).toLocaleString()} RPD`}
          </div>
          <div className="text-xs text-muted-foreground">
            Combined pool daily requests
          </div>
        </div>

        {/* Combined Throughput / RPM */}
        <div className="rounded-2xl bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Peak Throughput</span>
            <Activity className="size-4 text-primary" />
          </div>
          <div className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            {loading ? "…" : `${data?.geminiPool.combinedRpm ?? 0} RPM`}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <span>Avg Latency:</span>
            <span className={`font-mono font-medium ${getLatencyColor(data?.avgLatencyMs)}`}>
              {loading ? "…" : `${data?.avgLatencyMs ?? 0}ms`}
            </span>
          </div>
        </div>
      </div>

      {/* Gemini Multi-Worker Dynamic Pool Visualizer */}
      {geminiWorkers.length > 0 && (
        <div className="rounded-2xl bg-card p-4 sm:p-5 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Layers className="size-4 text-primary" />
                <span>Gemini Parallel Worker REST Pool ({geminiWorkers.length} Keys)</span>
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Each worker runs on an isolated API key from your pool to scale subtitle post-editing without hitting rate limits.
              </p>
            </div>
            <span className="text-xs font-mono text-primary bg-primary/10 px-2.5 py-1 rounded-lg self-start sm:self-auto">
              Throughput: {geminiWorkers.length * 15} req/min
            </span>
          </div>

          <div className="grid grid-cols-2 min-[480px]:grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2 pt-2">
            {geminiWorkers.map((w, idx) => {
              const badge = getStatusBadge(w.status, w.statusCode);
              return (
                <div
                  key={w.id}
                  className="rounded-xl bg-background/60 p-2.5 space-y-1.5 transition-all hover:bg-background/90"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-foreground truncate">
                      Worker #{idx + 1}
                    </span>
                    <span className={`size-1.5 rounded-full ${badge.dot}`} />
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground truncate" title={w.envVar}>
                    {w.envVar}
                  </div>
                  <div className="flex items-center justify-between text-[10px] pt-0.5">
                    <span className={`font-mono ${getLatencyColor(w.latencyMs)}`}>
                      {w.latencyMs ? `${w.latencyMs}ms` : "—"}
                    </span>
                    <span className={`rounded px-1.5 py-0.2 font-mono text-[9px] ${badge.cls}`}>
                      {w.status === "healthy" ? "OK" : w.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Provider Filter Tabs */}
      <div className="flex overflow-x-auto no-scrollbar gap-1 rounded-xl bg-card p-1.5 text-xs">
        {[
          { id: "all", label: `All Keys (${data?.keys.length ?? 0})` },
          { id: "gemini", label: `Gemini Pool (${geminiWorkers.length})` },
          { id: "groq", label: "Groq Cloud" },
          { id: "subdl", label: "SubDL API" },
          { id: "tmdb", label: "TMDB API" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setProviderFilter(tab.id)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 font-medium transition-colors cursor-pointer ${
              providerFilter === tab.id
                ? "bg-secondary text-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Individual Keys Table / Cards */}
      <div className="space-y-3">
        <div className="text-xs text-muted-foreground flex items-center justify-between">
          <span>{filteredKeys.length} API keys monitored</span>
          <span>Click key to copy variable name</span>
        </div>

        <div className="space-y-2.5">
          {filteredKeys.map((item) => {
            const badge = getStatusBadge(item.status, item.statusCode);
            const isCopied = copiedKeyId === item.id;

            return (
              <div
                key={item.id}
                className="rounded-2xl bg-card p-3.5 sm:p-4 transition-all hover:bg-card/85 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                {/* Left: Provider info & Env Var */}
                <div className="space-y-1 sm:max-w-md">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm text-foreground">
                      {item.providerName}
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground bg-background/60 px-2 py-0.5 rounded-md">
                      {item.envVar}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {item.role}
                  </p>
                  {item.error && (
                    <p className="text-[11px] text-destructive pt-0.5">
                      ⚠ {item.error}
                    </p>
                  )}
                </div>

                {/* Right: Key Snippet + Status + Latency + Limits */}
                <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 sm:gap-4 shrink-0 justify-between sm:justify-end">
                  {/* Masked Key */}
                  <button
                    type="button"
                    onClick={() => copyText(item.id, item.envVar)}
                    className="flex items-center gap-1.5 rounded-xl bg-background/60 px-2.5 py-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    title="Click to copy environment variable"
                  >
                    <span>{item.keyMasked}</span>
                    {isCopied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
                  </button>

                  {/* Latency */}
                  {item.status !== "unconfigured" && (
                    <div className="flex items-center gap-1 text-xs">
                      <Clock className="size-3 text-muted-foreground" />
                      <span className={`font-mono ${getLatencyColor(item.latencyMs)}`}>
                        {typeof item.latencyMs === "number" ? `${item.latencyMs}ms` : "—"}
                      </span>
                    </div>
                  )}

                  {/* Quota Specs */}
                  <div className="hidden lg:flex flex-col text-right text-[11px]">
                    <span className="text-foreground font-mono font-medium">{item.rateLimits.rpm} · {item.rateLimits.rpd}</span>
                    <span className="text-muted-foreground text-[10px]">{item.rateLimits.tier}</span>
                  </div>

                  {/* Status Badge */}
                  <div className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium ${badge.cls}`}>
                    <span className={`size-1.5 rounded-full ${badge.dot}`} />
                    <span>{badge.label}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
