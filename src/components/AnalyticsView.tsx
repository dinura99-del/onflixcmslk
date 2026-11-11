import React, { useState, useEffect, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell
} from "recharts";
import {
  TrendingUp, CheckCircle2, XCircle, Clock, Film, Tv, Users,
  Cpu, Sparkles, RefreshCw, ArrowUpRight, BarChart3, ShieldCheck
} from "lucide-react";
import { getAnalyticsData } from "@/lib/admin.functions";

type AnalyticsData = {
  counts: Record<string, number>;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  successRate: number;
  mediaSplit: {
    movies: number;
    tvShows: number;
  };
  dailyActivity: Array<{ date: string; completed: number; failed: number; total: number }>;
  requestsSummary: {
    total: number;
    pending: number;
    completed: number;
    rejected: number;
    topRequests: Array<{ title: string; count: number; type: string }>;
  };
  engineStatus: {
    geminiKeysCount: number;
    subdlKeysCount: number;
    workerCapacity: number;
  };
};

export function AnalyticsView({ k }: { k: string }) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await getAnalyticsData({ data: { key: k } });
      setData(res as AnalyticsData);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [k]);

  useEffect(() => {
    void load();
  }, [load]);

  if (err) {
    return (
      <div className="rounded-2xl bg-destructive/10 p-5 text-sm text-destructive">
        {err}
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    completed: "#4CDCDD",
    failed: "#EF4444",
    processing: "#3B82F6",
    waiting_embed: "#F59E0B",
    waiting_subtitle: "#F59E0B",
    upcoming: "#8B5CF6",
  };

  const statusLabels: Record<string, string> = {
    completed: "Completed",
    failed: "Failed",
    processing: "Processing",
    waiting_embed: "Waiting Video",
    waiting_subtitle: "Waiting Subtitle",
    upcoming: "Upcoming",
  };

  const statusData = data
    ? Object.entries(data.counts)
        .filter(([k]) => k !== "total" && (data.counts[k] ?? 0) > 0)
        .map(([key, value]) => ({
          name: statusLabels[key] ?? key,
          rawKey: key,
          value,
          color: statusColors[key] ?? "#4CDCDD",
        }))
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-semibold tracking-tight">Analytics & Engine Insights</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Real-time automation throughput, subtitle success metrics, user request trends, and Gemini capacity.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="self-start sm:self-auto flex items-center gap-1.5 rounded-xl bg-card border border-border/40 px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh Metrics</span>
        </button>
      </div>

      {/* Top KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4">
        {/* Total Processed */}
        <div className="rounded-2xl bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Completed Subtitles</span>
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <CheckCircle2 className="size-4" />
            </span>
          </div>
          <p className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-foreground tabular-nums">
            {loading ? "…" : data?.completedJobs ?? 0}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground flex items-center gap-1">
            <span className="text-primary font-semibold">
              {loading ? "…" : `${data?.successRate ?? 100}%`}
            </span>
            <span>overall success rate</span>
          </p>
        </div>

        {/* Media Distribution */}
        <div className="rounded-2xl bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Content Library</span>
            <span className="flex size-7 items-center justify-center rounded-lg bg-secondary text-foreground">
              <Film className="size-4" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-semibold text-foreground tabular-nums">
              {loading ? "…" : (data?.mediaSplit.movies ?? 0) + (data?.mediaSplit.tvShows ?? 0)}
            </span>
            <span className="text-xs text-muted-foreground">titles</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {loading ? "…" : `${data?.mediaSplit.movies ?? 0} movies · ${data?.mediaSplit.tvShows ?? 0} TV episodes`}
          </p>
        </div>

        {/* User Requests */}
        <div className="rounded-2xl bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">User Demand</span>
            <span className="flex size-7 items-center justify-center rounded-lg bg-warning/10 text-warning">
              <Users className="size-4" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-semibold text-foreground tabular-nums">
              {loading ? "…" : data?.requestsSummary.total ?? 0}
            </span>
            <span className="text-xs text-muted-foreground">requests</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {loading ? "…" : `${data?.requestsSummary.pending ?? 0} pending · ${data?.requestsSummary.completed ?? 0} fulfilled`}
          </p>
        </div>

        {/* Gemini Multi-Worker Pool */}
        <div className="rounded-2xl bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">AI Translation Engine</span>
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Cpu className="size-4" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-semibold text-primary tabular-nums">
              {loading ? "…" : `${data?.engineStatus.workerCapacity ?? 5}x`}
            </span>
            <span className="text-xs text-muted-foreground">parallel workers</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {loading ? "…" : `${data?.engineStatus.geminiKeysCount ?? 0} Gemini REST keys configured`}
          </p>
        </div>
      </div>

      {/* 14-Day Activity Chart */}
      <div className="rounded-2xl bg-card p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Automation Activity (Last 14 Days)</h3>
            <p className="text-xs text-muted-foreground">Daily processed Sinhala subtitles and publishing throughput.</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary" />
              <span>Completed</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-destructive" />
              <span>Failed</span>
            </span>
          </div>
        </div>

        <div className="h-60 sm:h-72 w-full pt-2">
          {data?.dailyActivity && data.dailyActivity.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.dailyActivity} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="completedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4CDCDD" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#4CDCDD" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="failedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#EF4444" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#EF4444" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  stroke="#525866"
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: "#252B35" }}
                />
                <YAxis
                  stroke="#525866"
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: "#252B35" }}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#13161A",
                    borderColor: "#252B35",
                    borderRadius: "0.75rem",
                    fontSize: "12px",
                    color: "#FFFFFF",
                  }}
                  itemStyle={{ padding: "2px 0" }}
                />
                <Area
                  type="monotone"
                  dataKey="completed"
                  name="Completed"
                  stroke="#4CDCDD"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#completedGrad)"
                />
                <Area
                  type="monotone"
                  dataKey="failed"
                  name="Failed"
                  stroke="#EF4444"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#failedGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No recent activity recorded
            </div>
          )}
        </div>
      </div>

      {/* Two Column Layout: Status Breakdown & Top User Requests */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Status Breakdown Bar Chart */}
        <div className="rounded-2xl bg-card p-4 sm:p-6 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Job Status Breakdown</h3>
            <p className="text-xs text-muted-foreground">Current state of titles in the subtitle automation database.</p>
          </div>

          <div className="h-56 w-full pt-1">
            {statusData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={statusData} layout="vertical" margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                  <XAxis type="number" stroke="#525866" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="#8A92A0"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={90}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(255, 255, 255, 0.04)" }}
                    contentStyle={{
                      backgroundColor: "#13161A",
                      borderColor: "#252B35",
                      borderRadius: "0.75rem",
                      fontSize: "12px",
                      color: "#FFFFFF",
                    }}
                  />
                  <Bar dataKey="value" name="Jobs" radius={[0, 6, 6, 0]}>
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                No jobs currently recorded
              </div>
            )}
          </div>
        </div>

        {/* Top Requested Titles */}
        <div className="rounded-2xl bg-card p-4 sm:p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Most Demanded Titles</h3>
              <p className="text-xs text-muted-foreground">Viewer requested movies and series awaiting subtitles.</p>
            </div>
      
          </div>

          <div className="space-y-2 pt-1">
            {data?.requestsSummary.topRequests && data.requestsSummary.topRequests.length > 0 ? (
              data.requestsSummary.topRequests.map((item, idx) => (
                <div
                  key={`${item.type}-${item.title}-${idx}`}
                  className="flex items-center justify-between gap-3 rounded-xl bg-secondary/50 px-3.5 py-2.5 text-xs transition-colors hover:bg-secondary"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-background text-[10px] font-semibold text-muted-foreground">
                      {idx + 1}
                    </span>
                    <span className="font-medium text-foreground truncate">{item.title}</span>
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground uppercase">
                      {item.type}
                    </span>
                  </div>
                  <span className="shrink-0 font-semibold text-primary tabular-nums">
                    {item.count} {item.count === 1 ? "request" : "requests"}
                  </span>
                </div>
              ))
            ) : (
              <div className="py-10 text-center text-xs text-muted-foreground">
                No user title requests submitted yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Engine & Health Banner */}
      <div className="rounded-2xl bg-card p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <h4 className="text-sm font-semibold text-foreground">Automation Engine Status</h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              Multi-Key REST pool healthy · {data?.engineStatus.geminiKeysCount ?? 0} Gemini Keys active · {data?.engineStatus.subdlKeysCount ?? 0} SubDL Keys ready · Stage 1 & Stage 2 active
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-auto text-xs text-success bg-success/10 px-3 py-1.5 rounded-xl font-medium">
          <span className="size-2 rounded-full bg-success animate-pulse" />
          <span>Operational</span>
        </div>
      </div>
    </div>
  );
}
