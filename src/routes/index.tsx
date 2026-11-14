import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { groupQueueSeasons } from "@/lib/queue-groups";
import {
  getEnv, getOverview, listJobs, getPreview, retryJob, deleteJob, deleteJobs, loadSettings, updateSettings, scanNow, processNow, tvSeasons,
  listUserRequests, updateUserRequestStatus, deleteUserRequest, getPendingRequestsCount, trackForAutomation,
} from "@/lib/admin.functions";
import {
  Film, Tv, CheckCircle2, XCircle, Clock, Play, Trash2, ExternalLink, Search, RefreshCw, Mail, Check, AlertCircle, ArrowRight,
  Bot, Send, RotateCcw, ChevronRight, List, Star, Database, Users, Sparkles, ArrowUp, Activity, ShieldCheck, Download, Menu, X,
  BarChart3, SlidersHorizontal, Key, Square,
} from "lucide-react";
import { MIGRATION_SQL } from "@/lib/sql";
import { PolishVisualizer, type PolishVisualState } from "@/components/PolishVisualizer";
import { AnalyticsView } from "@/components/AnalyticsView";
import { SubtitleEditorView } from "@/components/SubtitleEditorView";
import { TmdbExplorerView } from "@/components/TmdbExplorerView";
import { KeyHealthDashboardView } from "@/components/KeyHealthDashboardView";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "OnFlix Subtitle Automation — Admin" },
      { name: "description", content: "Queue, scanner and AI Sinhala translation engine for OnFlix subtitles." },
      { property: "og:title", content: "OnFlix Subtitle Automation — Admin" },
      { property: "og:description", content: "Queue, scanner and AI Sinhala translation engine for OnFlix subtitles." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: App,
});

const STATUS_META: Record<string, { label: string; cls: string }> = {
  upcoming: { label: "Upcoming", cls: "text-info bg-info/10" },
  waiting_embed: { label: "Waiting for Video", cls: "text-warning bg-warning/10" },
  waiting_subtitle: { label: "Waiting for Subtitle", cls: "text-warning bg-warning/10" },
  processing: { label: "Processing", cls: "text-primary bg-primary/10" },
  needs_review: { label: "Needs Review", cls: "text-warning bg-warning/10" },
  qa_waiting: { label: "QA_WAITING", cls: "text-info bg-info/10" },
  completed: { label: "Completed", cls: "text-success bg-success/10" },
  failed: { label: "Failed", cls: "text-destructive bg-destructive/10" },
};

type Tab = "overview" | "queue" | "requests" | "copilot" | "tmdb" | "keys" | "analytics" | "editor" | "settings" | "api" | "sql";

type ManualTarget = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title?: string;
  requestId?: number | string;
  autoStart?: boolean;
} | null;

function App() {
  const [key, setKey] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [manualTarget, setManualTarget] = useState<ManualTarget>(null);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);

  useEffect(() => setKey(localStorage.getItem("onflix_admin_key") ?? ""), []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setIsStandalone(true);
    }
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    const handleInstalled = () => {
      setIsStandalone(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const result = await installPrompt.userChoice;
    if (result.outcome === "accepted") {
      setIsStandalone(true);
    }
    setInstallPrompt(null);
  };

  const refreshPendingCount = useCallback(() => {
    if (!key) return;
    getPendingRequestsCount({ data: { key } }).then(setPendingCount).catch(() => {});
  }, [key]);

  useEffect(() => {
    refreshPendingCount();
    const interval = setInterval(refreshPendingCount, 15000);
    return () => clearInterval(interval);
  }, [refreshPendingCount]);

  if (key === null) return null;
  if (!key) return <Login onKey={(k) => { localStorage.setItem("onflix_admin_key", k); setKey(k); }} />;

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "overview", label: "Overview", icon: <Activity className="size-4" /> },
    { id: "queue", label: "Live Queue", icon: <Play className="size-4" /> },
    { id: "requests", label: pendingCount > 0 ? `User Requests (${pendingCount})` : "User Requests", icon: <Users className="size-4" /> },
    { id: "copilot", label: "AI Co-Pilot", icon: <Bot className="size-4" /> },
    { id: "tmdb", label: "TMDB Lookup", icon: <Search className="size-4" /> },
    { id: "keys", label: "API Keys & Quota", icon: <Key className="size-4" /> },
    { id: "analytics", label: "Analytics & Insights", icon: <BarChart3 className="size-4" /> },
    { id: "editor", label: "Subtitle Sync Editor", icon: <SlidersHorizontal className="size-4" /> },
    { id: "settings", label: "Filters & Scanner", icon: <ShieldCheck className="size-4" /> },
    { id: "api", label: "API & Cron", icon: <Database className="size-4" /> },
  ];

  return (
    <div className="min-h-screen">
      {/* Mobile Slide-Out Drawer ("Slide Bar") */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs transition-opacity md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] bg-card p-5 shadow-2xl flex flex-col justify-between transition-transform duration-300 ease-in-out md:hidden ${
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div>
          <div className="flex items-center justify-between pb-5 border-b border-border/40">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">OnFlix</p>
              <h2 className="text-lg font-semibold tracking-tight">Subtitle Automation</h2>
            </div>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="flex size-8 items-center justify-center rounded-xl bg-secondary text-muted-foreground hover:text-foreground cursor-pointer"
              aria-label="Close navigation"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="mt-5 space-y-1">
            {tabs.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setTab(t.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between rounded-xl px-3.5 py-3 text-sm font-medium transition-colors cursor-pointer ${
                    active
                      ? "bg-secondary text-foreground font-semibold shadow-xs"
                      : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className={active ? "text-primary" : "text-muted-foreground"}>{t.icon}</span>
                    <span>{t.label}</span>
                  </div>
                  {t.id === "requests" && pendingCount > 0 && (
                    <span className="inline-flex size-2 rounded-full bg-warning animate-pulse" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="pt-4 border-t border-border/40 space-y-2.5">
          {installPrompt && !isStandalone && (
            <button
              type="button"
              onClick={() => {
                handleInstallClick();
                setMobileMenuOpen(false);
              }}
              className="w-full flex items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/20 transition-all cursor-pointer"
            >
              <Download className="size-4" />
              <span>Install Web App</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem("onflix_admin_key");
              setKey("");
              setMobileMenuOpen(false);
            }}
            className="w-full rounded-xl bg-secondary/70 px-4 py-2.5 text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer text-center"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main Header */}
      <header className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 sm:px-6 pt-5 sm:pt-8">
        <div className="flex items-center gap-3">
          {/* Mobile Slide bar trigger button */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="md:hidden flex size-9 shrink-0 items-center justify-center rounded-xl bg-card border border-border/40 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors cursor-pointer"
            aria-label="Open navigation drawer"
          >
            <Menu className="size-5" />
          </button>
          <div>
          
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">OnFlix Subtitle Automation</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {installPrompt && !isStandalone && (
            <button
              onClick={handleInstallClick}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary/10 px-3 py-1.5 sm:px-3.5 sm:py-2 text-xs sm:text-sm font-medium text-primary hover:bg-primary/20 transition-all cursor-pointer"
              title="Install OnFlix CMS App on Desktop or Mobile"
            >
              <Download className="size-3.5 sm:size-4" />
              <span className="hidden sm:inline">Install App</span>
              <span className="sm:hidden">Install</span>
            </button>
          )}
          <button
            onClick={() => { localStorage.removeItem("onflix_admin_key"); setKey(""); }}
            className="rounded-xl bg-secondary px-3 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Scrollable Tab bar with no scrollbar */}
      <nav className="mx-auto mt-4 sm:mt-6 flex max-w-7xl gap-1 overflow-x-auto no-scrollbar px-4 sm:px-6 py-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`whitespace-nowrap rounded-xl px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-medium transition-colors cursor-pointer ${
              tab === t.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            {t.id === "requests" && pendingCount > 0 && (
              <span className="ml-2 inline-flex size-2 rounded-full bg-warning animate-pulse" />
            )}
          </button>
        ))}
      </nav>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8">
        {tab === "overview" && (
          <Overview
            k={key}
            manualTarget={manualTarget}
            onClearManualTarget={() => setManualTarget(null)}
            onOpenRequests={() => setTab("requests")}
            pendingRequestsCount={pendingCount}
          />
        )}
        {tab === "queue" && <Queue k={key} />}
        {tab === "requests" && (
          <UserRequestsView
            k={key}
            onProcess={(req) => {
              setManualTarget({
                tmdbId: req.tmdb_id,
                mediaType: req.type,
                title: req.title,
                requestId: req.id,
                autoStart: true,
              });
              setTab("overview");
            }}
            onCountChange={setPendingCount}
          />
        )}
        {tab === "copilot" && <CopilotView k={key} />}
        {tab === "tmdb" && (
          <TmdbExplorerView
            k={key}
            onSelectForProcess={(target) => {
              setManualTarget({
                tmdbId: target.tmdbId,
                mediaType: target.mediaType,
                title: target.title,
                autoStart: false,
              });
              setTab("overview");
            }}
          />
        )}
        {tab === "keys" && <KeyHealthDashboardView k={key} />}
        {tab === "analytics" && <AnalyticsView k={key} />}
        {tab === "editor" && <SubtitleEditorView k={key} />}
        {tab === "settings" && <SettingsView k={key} />}
        {tab === "api" && <ApiView k={key} />}
      </main>
    </div>
  );
}

function Login({ onKey }: { onKey: (k: string) => void }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <form className="w-full max-w-sm rounded-2xl bg-card p-8"
        onSubmit={async (e) => {
          e.preventDefault();
          try { await getEnv({ data: { key: v } }); onKey(v); } catch (x) { setErr((x as Error).message); }
        }}>
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">OnFlix</p>
        <h1 className="mt-1 text-xl font-semibold">Admin access</h1>
        <p className="mt-2 text-sm text-muted-foreground">Enter your CRON_SECRET to manage the automation.</p>
        <input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="Access key"
          className="mt-6 w-full rounded-xl bg-input px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
        {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
        <button className="mt-4 w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground">Continue</button>
      </form>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-card p-4 sm:p-6 ${className}`}>{children}</div>;
}

function Overview({
  k,
  manualTarget,
  onClearManualTarget,
  onOpenRequests,
  pendingRequestsCount = 0,
}: {
  k: string;
  manualTarget?: ManualTarget | undefined;
  onClearManualTarget?: (() => void) | undefined;
  onOpenRequests?: (() => void) | undefined;
  pendingRequestsCount?: number | undefined;
}) {
  const [c, setC] = useState<Record<string, number> | null>(null);
  const [err, setErr] = useState("");
  const [run, setRun] = useState<{ name: string; busy: boolean; logs: string[]; ok?: boolean } | null>(null);
  const load = useCallback(() => getOverview({ data: { key: k } }).then(setC).catch((e) => setErr(e.message)), [k]);
  useEffect(() => { load(); const i = setInterval(load, 10000); return () => clearInterval(i); }, [load]);

  const exec = async (name: string, fn: (o: { data: { key: string } }) => Promise<{ ok: boolean; logs: string[] }>) => {
    setRun({ name, busy: true, logs: [] });
    try {
      const r = await fn({ data: { key: k } });
      setRun({ name, busy: false, logs: r.logs, ok: r.ok });
    } catch (e) { setRun({ name, busy: false, logs: [(e as Error).message], ok: false }); }
    load();
  };

  const tiles: [string, string][] = [["total", "Total jobs"], ...Object.entries(STATUS_META).filter(([s]) => s !== "qa_waiting").map(([s, m]) => [s, m.label] as [string, string])];
  return (
    <div className="space-y-6">
      {err && <Card className="text-sm text-destructive">{err}</Card>}

      {pendingRequestsCount > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl bg-[#13161A] p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {pendingRequestsCount} User Title Request{pendingRequestsCount > 1 ? "s" : ""} Pending
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Users submitted title requests on OnFlix. You can 1-click upload them now.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenRequests}
            className="self-start sm:self-auto flex items-center gap-2 rounded-xl bg-[#4CDCDD] px-3.5 py-2 text-sm sm:text-[15px] font-semibold text-black cursor-pointer"
          >
            <span>View User Requests</span>
            <ArrowRight className="size-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4 lg:grid-cols-7">
        {tiles.map(([s, l]) => (
          <div key={s} className="rounded-2xl bg-card p-3.5 sm:p-5">
            <p className="text-xs text-muted-foreground truncate">{l}</p>
            <p className={`mt-1.5 sm:mt-2 text-2xl sm:text-3xl font-semibold tabular-nums ${s === "total" ? "" : STATUS_META[s]!.cls.split(" ")[0]}`}>{c ? c[s] ?? 0 : "—"}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ActionCard title="Scan Trending Now" desc="Stage 1 — discover trending & upcoming releases from TMDB and queue new jobs."
          busy={run?.busy && run.name === "scan"} disabled={run?.busy} onClick={() => exec("scan", scanNow)} />
        <ActionCard title="Process Batch Now" desc="Stage 2 — check video, fetch English SRT, translate to Sinhala and publish."
          busy={run?.busy && run.name === "process"} disabled={run?.busy} onClick={() => exec("process", processNow)} />
      </div>
      <ManualCard k={k} onDone={load} initialTarget={manualTarget} onClearTarget={onClearManualTarget} />
      {run && (
        <Card>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{run.name === "scan" ? "Scanner" : "Processor"} run</h3>
            <span className={`text-xs ${run.busy ? "text-primary" : run.ok ? "text-success" : "text-destructive"}`}>
              {run.busy ? "Running…" : run.ok ? "Finished" : "Failed"}
            </span>
          </div>
          {run.busy && <div className="mt-4 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full w-1/3 animate-pulse rounded-full bg-primary" /></div>}
          <pre className="mt-4 max-h-80 overflow-auto no-scrollbar whitespace-pre-wrap rounded-xl bg-background p-4 font-mono text-xs text-muted-foreground">{run.logs.join("\n") || "Working…"}</pre>
        </Card>
      )}
    </div>
  );
}

const STEPS = [
  { id: "tmdb", label: "TMDB details" },
  { id: "embed", label: "Video check" },
  { id: "srt", label: "English subtitle" },
  { id: "clean", label: "Cleaning" },
  { id: "translate", label: "Translating to Sinhala" },
  { id: "polish", label: "Gemini Sinhala polish" },
  { id: "upload", label: "Uploading" },
  { id: "publish", label: "Publishing" },
] as const;

const fmtTime = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

function ManualCard({
  k,
  onDone,
  initialTarget,
  onClearTarget,
}: {
  k: string;
  onDone: () => void | Promise<void>;
  initialTarget?: ManualTarget | undefined;
  onClearTarget?: (() => void) | undefined;
}) {
  const [type, setType] = useState<"movie" | "tv">("movie");
  const [id, setId] = useState("");
  const [season, setSeason] = useState("1");
  const [seasonTo, setSeasonTo] = useState("");
  const [episode, setEpisode] = useState("1");
  const [episodeTo, setEpisodeTo] = useState("");
  const [seasonInfo, setSeasonInfo] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);
  const targetRequestIdRef = useRef<number | string | null>(null);

  useEffect(() => {
    if (!initialTarget) return;
    setId(String(initialTarget.tmdbId));
    setType(initialTarget.mediaType);
    targetRequestIdRef.current = initialTarget.requestId ?? null;
    cardRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [initialTarget]);
  // Auto-fill latest season + released episode range when a TV TMDB ID is entered
  useEffect(() => {
    if (type !== "tv" || !/^\d+$/.test(id) || runningRef.current) { setSeasonInfo(""); return; }
    let off = false;
    const t = setTimeout(async () => {
      setSeasonInfo("Loading seasons…");
      try {
        const counts = await tvSeasons({ data: { key: k, tmdbId: Number(id) } });
        if (off) return;
        const aired = Object.entries(counts).map(([s, n]) => [Number(s), n] as const).filter(([s, n]) => s > 0 && n > 0);
        if (!aired.length) { setSeasonInfo("No released episodes yet"); return; }
        const [ls, ln] = aired[aired.length - 1]!;
        setSeason(String(ls)); setSeasonTo(""); setEpisode("1"); setEpisodeTo(String(ln));
        setSeasonInfo(`Season ${ls}: ${ln} episode${ln > 1 ? "s" : ""} released`);
      } catch { if (!off) setSeasonInfo("Couldn't load seasons"); }
    }, 500);
    return () => { off = true; clearTimeout(t); };
  }, [id, type, k]);
  type Issue = { cue: number; time: string; kind: "overlap" | "duplicate"; text: string };
  type QItem = { s?: number | undefined; ep: number; status: string; issues?: Issue[] | undefined };
  const [queue, setQueue] = useState<QItem[]>([]);
  const [reviewJob, setReviewJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(-1);
  const [pct, setPct] = useState<{ done: number; total: number } | null>(null);
  const [trStart, setTrStart] = useState(0);
  const [t0, setT0] = useState(0);
  const [now, setNow] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [final, setFinal] = useState<{ ok: boolean; status: string } | null>(null);
  const [polishState, setPolishState] = useState<PolishVisualState | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const inputCls = "w-full rounded-xl bg-input px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring";

  useEffect(() => {
    if (!busy) return;
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [busy]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [logs]);

  type Job = { id: string; type: "movie" | "tv"; season: string; queue: QItem[]; t0: number; logs: string[] };
  const JOB_KEY = "onflix_manual_job_v1";
  const saveJob = (j: Job | null) => {
    try { j ? localStorage.setItem(JOB_KEY, JSON.stringify({ ...j, logs: j.logs.slice(-400) })) : localStorage.removeItem(JOB_KEY); } catch { /* ignore */ }
  };
  const jobRef = useRef<Job | null>(null);
  const runningRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const abortRequestedRef = useRef(false);

  const handleStop = () => {
    if (!busy && !runningRef.current) return;
    abortRequestedRef.current = true;
    if (abortControllerRef.current) {
      try { abortControllerRef.current.abort(); } catch { /* ignore */ }
    }
    const stoppedLog = "⏹ Stop requested by user. Aborting process…";
    if (jobRef.current) {
      jobRef.current.logs = [...jobRef.current.logs, stoppedLog];
      jobRef.current.queue = jobRef.current.queue.map((x) =>
        x.status === "running" || x.status === "todo" ? { ...x, status: "failed" } : x
      );
      setQueue(jobRef.current.queue);
      saveJob(null);
    }
    setLogs((l) => [...l, stoppedLog]);
    runningRef.current = false;
    setBusy(false);
    setFinal({ ok: false, status: "failed" });
    onClearTarget?.();
  };

  const runQueue = async (job: Job) => {
    if (runningRef.current) return;
    runningRef.current = true;
    abortRequestedRef.current = false;
    jobRef.current = job;
    setId(job.id); setType(job.type); setSeason(job.season);
    setQueue(job.queue); setLogs(job.logs); setT0(job.t0);
    setBusy(true); setStarted(true); setFinal(null);
    const push = (line: string) => { job.logs = [...job.logs, line]; saveJob(job); };
    for (let i = 0; i < job.queue.length; i++) {
      if (abortRequestedRef.current) break;
      const it = job.queue[i]!;
      if (it.status !== "todo" && it.status !== "running") continue;
      job.queue = job.queue.map((x, j) => (j === i ? { ...x, status: "running" } : x));
      setQueue(job.queue); saveJob(job);
      if (job.queue.length > 1) { const l = `━━ ${it.s != null ? `S${it.s}` : ""}E${it.ep} (${i + 1}/${job.queue.length}) ━━`; push(l); setLogs((x) => [...x, l]); }
      const res = await runOne(it.ep, job, push, undefined, it.s);
      job.queue = job.queue.map((x, j) => (j === i ? { ...x, status: res.status, issues: res.issues } : x));
      setQueue(job.queue); saveJob(job);

      // 1. Check if user requested stop
      if (abortRequestedRef.current) {
        const stopMsg = `⏹ Stopped: Run aborted by user after ${it.s != null ? `S${it.s}` : ""}E${it.ep}.`;
        push(stopMsg); setLogs((x) => [...x, stopMsg]);
        break;
      }

      // 2. Strict sequential dependency: if episode does not complete (e.g. Ep 5 not found or failed), DO NOT proceed to Ep 6!
      if (res.status !== "completed") {
        const remainingCount = job.queue.length - 1 - i;
        const epLabel = `${it.s != null ? `S${it.s}` : ""}E${it.ep}`;
        const stopMsg = remainingCount > 0
          ? `⏹ Sequential Halt: ${epLabel} did not complete (${res.status}). Stopped queue — will not proceed to subsequent ${remainingCount} episode(s).`
          : `⏹ ${epLabel} ended with status: ${res.status}.`;
        push(stopMsg); setLogs((x) => [...x, stopMsg]);
        // Mark all remaining todo episodes as stopped/failed so they are not left hanging
        job.queue = job.queue.map((x, j) => (j > i && x.status === "todo" ? { ...x, status: "failed" } : x));
        setQueue(job.queue); saveJob(job);
        break;
      }

      if (res.polishStopped) break;
    }
    const bad = job.queue.filter((q) => q.status !== "completed");
    setFinal({ ok: !bad.length, status: bad.length ? bad[bad.length - 1]!.status : "completed" });
    setReviewJob(job.queue.some((q) => q.status === "needs_review") ? job : null);
    if (!bad.length && targetRequestIdRef.current) {
      const rid = targetRequestIdRef.current;
      targetRequestIdRef.current = null;
      void updateUserRequestStatus({ data: { key: k, id: rid, status: "completed" } });
    }
    saveJob(null); jobRef.current = null; runningRef.current = false;
    setNow(Date.now()); setBusy(false); onDone();
    onClearTarget?.();
  };

  useEffect(() => {
    try {
      const raw = localStorage.getItem(JOB_KEY);
      if (!raw) return;
      const job = JSON.parse(raw) as Job;
      if (!job?.queue?.some((q) => q.status === "todo" || q.status === "running")) { saveJob(null); return; }
      job.logs = [...(job.logs ?? []), "↻ Page reloaded — resuming…"];
      void runQueue(job);
    } catch { saveJob(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const from = Number(episode);
    const sFrom = Number(season);
    const sTo = Math.max(sFrom, Number(seasonTo) || sFrom);
    let items: QItem[] = [{ ep: 0, status: "todo" }];
    if (type === "tv") {
      if (sTo === sFrom) {
        const to = Math.max(from, Number(episodeTo) || from);
        items = Array.from({ length: Math.min(to - from + 1, 100) }, (_, i) => ({ s: sFrom, ep: from + i, status: "todo" }));
      } else {
        let counts: Record<number, number>;
        try { counts = await tvSeasons({ data: { key: k, tmdbId: Number(id) } }); }
        catch (x) { setStarted(true); setLogs([`✗ ${(x as Error).message}`]); setFinal({ ok: false, status: "failed" }); return; }
        items = [];
        for (let sn = sFrom; sn <= sTo; sn++) {
          const n = counts[sn] ?? 0;
          const a = sn === sFrom ? from : 1;
          const b = sn === sTo && Number(episodeTo) ? Math.min(Number(episodeTo), n) : n;
          for (let e = a; e <= b; e++) items.push({ s: sn, ep: e, status: "todo" });
        }
        items = items.slice(0, 300);
      }
    }
    const job: Job = { id, type, season, queue: items, t0: Date.now(), logs: [] };
    saveJob(job); setReviewJob(null);
    await runQueue(job);
  };

  const [trackingCron, setTrackingCron] = useState(false);
  const [trackMessage, setTrackMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const handleTrackForCron = async () => {
    if (!id) return;
    setTrackingCron(true);
    setTrackMessage(null);
    try {
      const res = await trackForAutomation({
        data: {
          key: k,
          tmdbId: Number(id),
          mediaType: type,
          season: type === "tv" ? Number(season) : undefined,
          episodeFrom: type === "tv" ? Number(episode) : undefined,
          episodeTo: type === "tv" && episodeTo ? Number(episodeTo) : undefined,
        },
      });
      if (res.isUpcoming) {
        setTrackMessage({
          ok: true,
          text: `✓ Queued ${res.count} title(s) as Upcoming! (Release Date: ${res.releaseDate}). Cron job will automatically process on release.`,
        });
      } else {
        setTrackMessage({
          ok: true,
          text: `✓ Queued ${res.count} title(s) for Automation! (Waiting for Video). Cron job will process on next cycle.`,
        });
      }
      onDone();
    } catch (err) {
      setTrackMessage({ ok: false, text: `✗ ${(err as Error).message}` });
    } finally {
      setTrackingCron(false);
    }
  };

  const approve = async (sn: number | undefined, ep: number, mode: "fix" | "keep") => {
    const job = reviewJob; if (!job || runningRef.current) return;
    runningRef.current = true; setBusy(true); setFinal(null);
    const push = (line: string) => { job.logs = [...job.logs, line]; };
    const res = await runOne(ep, job, push, mode, sn);
    job.queue = job.queue.map((x) => (x.ep === ep && x.s === sn ? { ...x, status: res.status, issues: res.issues } : x));
    setQueue(job.queue);
    const bad = job.queue.filter((q) => q.status !== "completed");
    setFinal({ ok: !bad.length, status: bad.length ? bad[bad.length - 1]!.status : "completed" });
    setReviewJob(job.queue.some((q) => q.status === "needs_review") ? { ...job } : null);
    runningRef.current = false; setNow(Date.now()); setBusy(false); onDone();
  };

  const runOne = async (ep: number, job: Job, push: (l: string) => void, review?: "fix" | "keep", sn?: number): Promise<{ status: string; issues?: Issue[] | undefined; polishStopped?: boolean }> => {
    const start = Date.now();
    setStep(-1); setPct(null); setFinal(null); setNow(start); setPolishState(null);
    let status = "failed"; let issues: Issue[] | undefined; let polishStopped = false;
    const srtCacheKey = `onflix_srt_cache_${job.type}_${job.id}_${sn ?? 0}_${ep}`;
    let cachedData: { translatedSrt?: string; polishedCues?: Record<string, string> } = {};
    try {
      const rawCache = localStorage.getItem(srtCacheKey);
      if (rawCache) cachedData = JSON.parse(rawCache);
    } catch { /* ignore */ }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    // Reconnect up to 3 times on a dropped stream; each retry resends the cached draft/polished cues.
    for (let attempt = 0; ; attempt++) {
    let gotDone = false;
    try {
      const r = await fetch("/api/public/manual/stream", {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          key: k, tmdbId: Number(job.id), mediaType: job.type,
          ...(job.type === "tv" ? { season: sn ?? Number(job.season), episode: ep } : {}),
          ...(review ? { review } : {}),
          cachedTranslatedSrt: cachedData.translatedSrt,
          cachedPolishedCues: cachedData.polishedCues,
        }),
      });
      if (!r.ok || !r.body) throw new Error(r.status === 401 ? "Invalid access key" : `Request failed (${r.status})`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as {
            log?: string;
            done?: boolean;
            status?: string;
            issues?: Issue[];
            trSrt?: string;
            polishedChunk?: [number, string][];
          };
          if (ev.trSrt) {
            cachedData.translatedSrt = ev.trSrt;
            try { localStorage.setItem(srtCacheKey, JSON.stringify(cachedData)); } catch { /* ignore */ }
          }
          if (ev.polishedChunk && Array.isArray(ev.polishedChunk)) {
            if (!cachedData.polishedCues) cachedData.polishedCues = {};
            for (const [cid, text] of ev.polishedChunk) {
              cachedData.polishedCues[String(cid)] = text;
            }
            try { localStorage.setItem(srtCacheKey, JSON.stringify(cachedData)); } catch { /* ignore */ }
          }
          if (ev.done) {
            gotDone = true;
            status = ev.status ?? "failed";
            issues = ev.issues?.length ? ev.issues : undefined;
            if (status === "completed") {
              try { localStorage.removeItem(srtCacheKey); } catch { /* ignore */ }
            }
            continue;
          }
          const m = ev.log ?? "";
          if (/✗.*(?:Gemini|polish|Base translation cue)/i.test(m)) polishStopped = true;
          if (m.startsWith("@@step:")) {
            const i = STEPS.findIndex((s) => s.id === m.slice(7));
            if (i >= 0) { setStep(i); if (STEPS[i]?.id === "translate" || STEPS[i]?.id === "polish") { setTrStart(Date.now()); setPct({ done: 0, total: 0 }); } }
          } else if (m.startsWith("@@pct:")) {
            const [d, t] = m.slice(6).split("/").map(Number);
            if (d !== undefined && t !== undefined && Number.isFinite(d) && Number.isFinite(t)) setPct({ done: d, total: t });
          } else if (m.startsWith("@@polish_init:")) {
            const [tc, wc, cues] = m.slice(14).split(":").map(Number);
            const totalChunks = tc || 0;
            const workerCount = wc ?? 1;
            const totalCues = cues || 0;
            setPolishState({
              totalChunks,
              totalCues,
              workerCount,
              active: true,
              completed: false,
              workers: Array.from({ length: workerCount }, (_, idx) => ({ id: idx + 1, status: "idle", cuesDone: 0 })),
              chunks: Array.from({ length: totalChunks }, (_, idx) => ({ id: idx, startCue: 0, endCue: 0, status: "pending" })),
            });
          } else if (m.startsWith("@@worker_start:")) {
            const [wid, cidx, sc, ec] = m.slice(15).split(":").map(Number);
            setPolishState((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                active: true,
                workers: prev.workers.map((w) =>
                  w.id === wid ? { ...w, status: "active" as const, currentChunk: cidx, startCue: sc, endCue: ec } : w
                ),
                chunks: prev.chunks.map((c, i) =>
                  i === cidx ? { ...c, status: "processing" as const, workerId: wid, startCue: sc || c.startCue, endCue: ec || c.endCue } : c
                ),
              };
            });
          } else if (m.startsWith("@@worker_done:")) {
            const [wid, cidx, sc, ec] = m.slice(14).split(":").map(Number);
            setPolishState((prev) => {
              if (!prev) return prev;
              const chunkLen = ec && sc ? ec - sc + 1 : 0;
              return {
                ...prev,
                workers: prev.workers.map((w) =>
                  w.id === wid ? { ...w, status: "cooldown" as const, cuesDone: w.cuesDone + chunkLen } : w
                ),
                chunks: prev.chunks.map((c, i) =>
                  i === cidx ? { ...c, status: "done" as const, workerId: wid, startCue: sc || c.startCue, endCue: ec || c.endCue } : c
                ),
              };
            });
          } else if (m.startsWith("@@worker_retry:")) {
            const [wid, cidx] = m.slice(15).split(":").map(Number);
            setPolishState((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                workers: prev.workers.map((w) => (w.id === wid ? { ...w, status: "retrying" as const } : w)),
                chunks: prev.chunks.map((c, i) => (i === cidx ? { ...c, status: "retrying" as const } : c)),
              };
            });
          } else if (m.startsWith("@@worker_idle:")) {
            const wid = Number(m.slice(14));
            setPolishState((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                workers: prev.workers.map((w) => (w.id === wid ? { ...w, status: "idle" as const } : w)),
              };
            });
          } else if (m.startsWith("@@worker_complete:")) {
            const wid = Number(m.slice(18));
            setPolishState((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                workers: prev.workers.map((w) => (w.id === wid ? { ...w, status: "completed" as const } : w)),
              };
            });
          } else if (m.startsWith("@@polish_complete") || m.includes("Gemini polish complete")) {
            setPolishState((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                active: false,
                completed: true,
                workers: prev.workers.map((w) => ({ ...w, status: "completed" as const })),
                chunks: prev.chunks.map((c) => ({ ...c, status: "done" as const })),
              };
            });
          } else {
            const initMatch = m.match(/Gemini Flash polish:\s*(\d+)\s*chunks,\s*(\d+)\s*parallel worker/i);
            if (initMatch && initMatch[1] && initMatch[2]) {
              const tc = Number(initMatch[1]);
              const wc = Number(initMatch[2]);
              setPolishState((prev) => {
                if (prev && prev.totalChunks === tc) return prev;
                return {
                  totalChunks: tc,
                  totalCues: 0,
                  workerCount: wc,
                  active: true,
                  completed: false,
                  workers: Array.from({ length: wc }, (_, idx) => ({ id: idx + 1, status: "active", cuesDone: 0 })),
                  chunks: Array.from({ length: tc }, (_, idx) => ({ id: idx, startCue: 0, endCue: 0, status: "pending" })),
                };
              });
            }
            push(m);
            setLogs((l) => [...l, m]);
          }
        }
      }
      if (!gotDone) throw new TypeError("stream ended before the job finished");
      break;
    } catch (x) {
      if ((x as Error).name === "AbortError" || abortRequestedRef.current) {
        const l = "⏹ Step cancelled by user."; push(l); setLogs((v) => [...v, l]);
        break;
      }
      const msg = (x as Error).message;
      const permanent = msg === "Invalid access key" || /^Request failed \(4\d\d\)/.test(msg);
      if (!permanent && attempt < 3) {
        const waitS = 3 * (attempt + 1);
        const l = `↻ connection lost (${msg}) — reconnecting ${attempt + 1}/3 in ${waitS}s, resuming from saved lines…`;
        push(l); setLogs((v) => [...v, l]);
        await new Promise((res) => setTimeout(res, waitS * 1000));
        if (abortRequestedRef.current) { const c = "⏹ Step cancelled by user."; push(c); setLogs((v) => [...v, c]); break; }
        continue;
      }
      const l = `✗ ${msg}`; push(l); setLogs((v) => [...v, l]);
      break;
    }
    }
    try {
      // fallthrough to cleanup
    } finally {
      abortControllerRef.current = null;
    }
    return { status, polishStopped, ...(issues ? { issues } : {}) };
  };

  const percent = pct && pct.total ? Math.round((pct.done / pct.total) * 100) : 0;
  const trElapsed = now - trStart;
  const eta = pct && pct.done > 0 && pct.total > pct.done ? (trElapsed / pct.done) * (pct.total - pct.done) : null;
  const failed = final && !final.ok;
  const overall = final?.ok ? 100 : Math.round(((Math.max(step, 0) + (STEPS[step]?.id === "translate" || STEPS[step]?.id === "polish" ? percent / 100 : 0)) / STEPS.length) * 100);

  return (
    <div ref={cardRef}>
      <Card>
        {initialTarget && (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-primary/40 bg-primary/10 p-3 text-xs">
            <div className="flex items-center gap-2">
              <Play className="size-3.5 fill-current text-primary" />
              <span className="font-medium text-foreground">
                Processing User Request #{initialTarget.requestId}: <strong className="text-primary">{initialTarget.title || initialTarget.tmdbId}</strong>
              </span>
            </div>
            <button type="button" onClick={onClearTarget} className="text-muted-foreground hover:text-foreground">✕ Dismiss</button>
          </div>
        )}
        <h3 className="font-semibold">Manual Process by TMDB ID</h3>
      <p className="mt-1 text-sm text-muted-foreground">Fetch, clean, translate and publish a single title right now.</p>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex rounded-xl bg-input p-1.5">
            {(["movie", "tv"] as const).map((t) => (
              <button type="button" key={t} onClick={() => setType(t)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${type === t ? "bg-secondary text-foreground" : "text-muted-foreground"}`}>
                {t === "movie" ? "Movie" : "TV Show"}
              </button>
            ))}
          </div>
          <label className="w-full sm:w-36"><span className="text-xs text-muted-foreground">TMDB ID</span>
            <input required inputMode="numeric" pattern="[0-9]+" value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. 550" className={`mt-1 ${inputCls}`} /></label>
          {type === "tv" && (<>
            <label className="w-[calc(50%-0.5rem)] sm:w-24"><span className="text-xs text-muted-foreground">Season from</span>
              <input required type="number" min={0} value={season} onChange={(e) => setSeason(e.target.value)} className={`mt-1 ${inputCls}`} /></label>
            <label className="w-[calc(50%-0.5rem)] sm:w-24"><span className="text-xs text-muted-foreground">to (optional)</span>
              <input type="number" min={0} value={seasonTo} onChange={(e) => setSeasonTo(e.target.value)} placeholder={season} className={`mt-1 ${inputCls}`} /></label>
            <label className="w-[calc(50%-0.5rem)] sm:w-24"><span className="text-xs text-muted-foreground">Episode from</span>
              <input required type="number" min={1} value={episode} onChange={(e) => setEpisode(e.target.value)} className={`mt-1 ${inputCls}`} /></label>
            <label className="w-[calc(50%-0.5rem)] sm:w-24"><span className="text-xs text-muted-foreground">to (optional)</span>
              <input type="number" min={1} value={episodeTo} onChange={(e) => setEpisodeTo(e.target.value)} placeholder={Number(seasonTo) > Number(season) ? "last" : episode} className={`mt-1 ${inputCls}`} /></label>
          </>)}
          {busy ? (
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button disabled className="flex-1 sm:flex-initial rounded-xl bg-primary/40 px-4 py-2.5 text-sm font-semibold text-primary-foreground flex items-center justify-center gap-2 cursor-not-allowed">
                <RefreshCw className="size-3.5 animate-spin" />
                <span>Processing…</span>
              </button>
              <button
                type="button"
                onClick={handleStop}
                className="flex-1 sm:flex-initial rounded-xl bg-destructive/15 text-destructive hover:bg-destructive hover:text-white px-4 py-2.5 text-sm font-semibold transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                title="Stop workflow immediately"
              >
                <Square className="size-3.5 fill-current" />
                <span>Stop</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button className="flex-1 sm:flex-initial rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity cursor-pointer">
                Process Now
              </button>
              <button
                type="button"
                onClick={handleTrackForCron}
                disabled={trackingCron || !id}
                className="flex-1 sm:flex-initial rounded-xl bg-secondary px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-secondary/80 transition-colors cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50"
                title="Add to Cron Queue for automatic release detection without processing immediately"
              >
                <Clock className={`size-3.5 text-primary ${trackingCron ? "animate-spin" : ""}`} />
                <span>{trackingCron ? "Queueing…" : "Track for Cron"}</span>
              </button>
            </div>
          )}
        </div>

        {trackMessage && (
          <div className={`mt-3 rounded-xl p-3 text-xs flex items-center justify-between ${
            trackMessage.ok ? "bg-primary/10 text-primary border border-primary/20" : "bg-destructive/10 text-destructive border border-destructive/20"
          }`}>
            <span>{trackMessage.text}</span>
            <button type="button" onClick={() => setTrackMessage(null)} className="opacity-70 hover:opacity-100 ml-2">✕</button>
          </div>
        )}

        {type === "tv" && seasonInfo && (
          <div className="flex items-center gap-2 pt-0.5 text-xs text-muted-foreground">
            <span className="inline-block size-1.5 rounded-full bg-primary" />
            <span>{seasonInfo}</span>
          </div>
        )}
      </form>

      {started && (
        <div className="mt-6 animate-in fade-in slide-in-from-top-2 duration-500">
          <div className="flex items-center justify-between text-xs">
            <span className={busy ? "text-primary font-medium" : final?.status === "qa_waiting" ? "text-info font-medium" : final?.ok ? "text-success font-medium" : "text-destructive font-medium"}>
              {busy ? `${queue.length > 1 ? `Episode ${queue.findIndex((q) => q.status === "running") + 1}/${queue.length} · ` : ""}Step ${Math.max(step, 0) + 1} of ${STEPS.length}` : STATUS_META[final!.status]?.label ?? final!.status}
            </span>
            <div className="flex items-center gap-2.5">
              <span className="font-mono tabular-nums text-muted-foreground">⏱ {fmtTime(now - t0)}</span>
              {busy && (
                <button
                  type="button"
                  onClick={handleStop}
                  className="rounded-lg bg-destructive/15 text-destructive hover:bg-destructive hover:text-white px-2 py-0.5 text-[11px] font-semibold transition-colors cursor-pointer flex items-center gap-1"
                  title="Stop active workflow"
                >
                  <Square className="size-2.5 fill-current" />
                  <span>Stop</span>
                </button>
              )}
            </div>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full transition-all duration-700 ease-out ${failed && final?.status !== "qa_waiting" ? "bg-destructive" : final?.ok ? "bg-success" : "bg-primary"}`}
              style={{ width: `${overall}%` }} />
          </div>

          {queue.length > 1 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {queue.map((q) => (
                <span key={`${q.s}-${q.ep}`} className={`rounded-lg px-2.5 py-1 font-mono text-[11px] transition-all duration-500 ${
                  q.status === "completed" ? "bg-success/20 text-success"
                  : q.status === "running" ? "animate-pulse bg-primary/20 text-primary"
                  : q.status === "todo" ? "bg-muted text-muted-foreground"
                  : q.status === "needs_review" ? "bg-warning/20 text-warning"
                  : q.status === "qa_waiting" ? "bg-info/20 text-info"
                  : "bg-destructive/20 text-destructive"}`}>
                  {q.s != null && Number(seasonTo) > Number(season) ? `S${q.s}` : ""}E{q.ep}{q.status === "qa_waiting" ? " QA_WAITING" : q.status === "completed" ? " ✓" : q.status === "needs_review" ? " ⚠" : q.status === "todo" || q.status === "running" ? "" : " ✕"}
                </span>
              ))}
            </div>
          )}
          <ol className="mt-5 space-y-1">
            {STEPS.map((s, i) => {
              const state = final?.ok || i < step ? "done" : i === step ? (failed && final?.status !== "qa_waiting" ? "fail" : final ? "stop" : "active") : "todo";
              return (
                <li key={s.id} className={`flex flex-col rounded-xl px-3 py-2 transition-all duration-500 ${state === "active" ? "bg-secondary/60" : ""} ${state === "todo" ? "opacity-40" : "opacity-100"}`}>
                  <div className="flex items-center gap-3">
                    <span className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-all duration-500 ${
                      state === "done" ? "bg-success text-background scale-100"
                      : state === "active" ? "bg-primary text-primary-foreground"
                      : state === "fail" ? "bg-destructive text-background"
                      : state === "stop" ? "bg-muted-foreground/40 text-foreground"
                      : "bg-muted text-muted-foreground"}`}>
                      {state === "active" && <span className="absolute inset-0 animate-ping rounded-full bg-primary/40" />}
                      {state === "done" ? <Check className="relative size-3.5" /> : state === "fail" ? <X className="relative size-3.5" /> : <span className="relative">{i + 1}</span>}
                    </span>
                    <span className={`text-sm ${state === "active" ? "font-medium text-foreground" : "text-muted-foreground"}`}>{s.label}</span>
                    {(s.id === "translate" || s.id === "polish") && pct && state !== "todo" && (
                      <span className="ml-auto font-mono text-xs tabular-nums text-foreground">{state === "done" ? 100 : percent}%</span>
                    )}
                  </div>
                  {s.id === "translate" && state === "active" && pct && (
                    <div className="mt-2 pl-9 animate-in fade-in duration-300">
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary transition-all duration-500 ease-out" style={{ width: `${percent}%` }} />
                      </div>
                      <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-muted-foreground">
                        <span>{pct.total ? `${pct.done} / ${pct.total} lines` : "Starting…"}</span>
                        <span>{fmtTime(trElapsed)} elapsed{eta != null ? ` · ~${fmtTime(eta)} left` : ""}</span>
                      </div>
                    </div>
                  )}
                  {s.id === "polish" && (state === "active" || polishState?.active || (state === "done" && polishState?.completed)) && (
                    <div className="pl-9">
                      {polishState ? (
                        <PolishVisualizer
                          state={polishState}
                          percent={state === "done" ? 100 : percent}
                          elapsed={trElapsed}
                          eta={state === "done" ? null : eta}
                          fmtTime={fmtTime}
                        />
                      ) : (
                        state === "active" && pct && (
                          <div className="mt-2 animate-in fade-in duration-300">
                            <div className="h-2 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-primary transition-all duration-500 ease-out" style={{ width: `${percent}%` }} />
                            </div>
                            <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-muted-foreground">
                              <span>{pct.total ? `${pct.done} / ${pct.total} cues` : "Initializing Multi-AI Workers…"}</span>
                              <span>{fmtTime(trElapsed)} elapsed{eta != null ? ` · ~${fmtTime(eta)} left` : ""}</span>
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {reviewJob && queue.filter((q) => q.status === "needs_review").map((q) => (
            <div key={`${q.s}-${q.ep}`} className="mt-4 rounded-xl border border-warning/40 bg-warning/5 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold">⚠ OnFlix watermark ගැටලු{type === "tv" ? ` — ${q.s != null ? `S${q.s}` : ""}E${q.ep}` : ""}</h4>
                <span className="text-xs text-muted-foreground">publish කරන්න කලින් තහවුරු කරන්න</span>
              </div>
              <ul className="mt-3 space-y-2">
                {(q.issues ?? []).map((it, n) => (
                  <li key={n} className="rounded-lg bg-background p-2.5 text-xs">
                    <div className="flex flex-wrap gap-2 font-mono text-muted-foreground">
                      <span>#{it.cue}</span><span>{it.time}</span>
                      <span className={`rounded px-1.5 ${it.kind === "overlap" ? "bg-destructive/20 text-destructive" : "bg-warning/20 text-warning"}`}>
                        {it.kind === "overlap" ? "දෙබස් සමඟ ගැටේ" : "දෙවරක් එකතු වී ඇත"}
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap">{it.text}</p>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <button disabled={busy} onClick={() => approve(q.s, q.ep, "fix")}
                  className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">Fix කරලා Publish</button>
                <button disabled={busy} onClick={() => approve(q.s, q.ep, "keep")}
                  className="rounded-lg bg-secondary px-4 py-2 text-xs font-medium disabled:opacity-50">තියෙන විදිහටම Publish</button>
              </div>
            </div>
          ))}

          {logs.length > 0 && (
            <pre ref={logRef} className="mt-4 max-h-56 overflow-auto no-scrollbar whitespace-pre-wrap rounded-xl bg-background p-4 font-mono text-xs text-muted-foreground">{logs.join("\n")}</pre>
          )}
        </div>
      )}
      </Card>
    </div>
  );
}

function ActionCard({ title, desc, onClick, busy, disabled }: { title: string; desc: string; onClick: () => void; busy?: boolean | undefined; disabled?: boolean | undefined }) {
  return (
    <Card className="flex flex-col justify-between gap-6">
      <div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm text-muted-foreground">{desc}</p></div>
      <button onClick={onClick} disabled={disabled}
        className="self-start rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
        {busy ? "Running…" : "Run now"}
      </button>
    </Card>
  );
}

type Job = Awaited<ReturnType<typeof listJobs>>[number];
const fmtCountdown = (d: string | null | undefined, now: number) => {
  if (!d) return "--:--";
  const remaining = Date.parse(d) - now;
  if (!Number.isFinite(remaining)) return "--:--";
  const totalSeconds = Math.max(0, Math.ceil(remaining / 1000));
  if (totalSeconds === 0) return "00:00";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};
const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString() : "—");

function orderQueueRowsForDisplay(rows: Job[]): Job[] {
  const groups = new Map<string, Job[]>();
  for (const row of rows) {
    const key = row.media_type === "tv" ? `tv:${row.tmdb_id}` : `job:${row.id}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return Array.from(groups.values()).flatMap((group) => {
    if (group.length < 2 || group[0]?.media_type !== "tv") return group;
    return [...group].sort(
      (left, right) =>
        Number(left.season_number ?? 0) - Number(right.season_number ?? 0) ||
        Number(left.episode_number ?? 0) - Number(right.episode_number ?? 0),
    );
  });
}

function Queue({ k }: { k: string }) {
  const [status, setStatus] = useState("all");
  const [clockNow, setClockNow] = useState(Date.now());
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Job[]>([]);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [seasonExpanded, setSeasonExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(() => listJobs({ data: { key: k, status, q } }).then((r) => {
    setRows(r);
    setErr("");
    setSelected((prev) => {
      const existing = new Set(r.map((j) => j.id));
      const next = new Set<string>();
      for (const id of prev) if (existing.has(id)) next.add(id);
      return next;
    });
  }).catch((e) => setErr(e.message)), [k, status, q]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { const timer = setInterval(load, 15000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { const timer = setInterval(() => setClockNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const toggleSelectAll = () => {
    if (selected.size === rows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeleteOne = async (job: Job) => {
    if (!confirm(`Are you sure you want to delete "${job.title}" from the queue?`)) return;
    try {
      setBusyId(job.id);
      await deleteJob({ data: { key: k, id: job.id } });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selected.size) return;
    if (!confirm(`Delete ${selected.size} selected job(s) from the queue?`)) return;
    try {
      setBulkBusy(true);
      await deleteJobs({ data: { key: k, ids: Array.from(selected) } });
      setSelected(new Set());
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleClearCompleted = async () => {
    const completedIds = rows.filter((r) => r.status === "completed").map((r) => r.id);
    if (!completedIds.length) return;
    if (!confirm(`Delete all ${completedIds.length} completed job(s)?`)) return;
    try {
      setBulkBusy(true);
      await deleteJobs({ data: { key: k, ids: completedIds } });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };

  const completedCount = rows.filter((r) => r.status === "completed").length;
  const displayRows = orderQueueRowsForDisplay(rows);
  const seasonGroups = groupQueueSeasons(displayRows, status === "all" && !q.trim());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 flex-wrap gap-3">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or TMDB ID"
            className="min-w-64 flex-1 rounded-xl bg-card px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
          <div className="flex flex-wrap gap-1 rounded-xl bg-card p-1">
            {["all", ...Object.keys(STATUS_META)].map((s) => (
              <button key={s} onClick={() => setStatus(s)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ${status === s ? "bg-secondary text-foreground" : "text-muted-foreground"}`}>
                {s === "all" ? "All" : STATUS_META[s]!.label}
              </button>
            ))}
          </div>
        </div>

        {completedCount > 0 && (
          <button
            onClick={handleClearCompleted}
            disabled={bulkBusy}
            className="rounded-xl border border-border bg-card px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors disabled:opacity-50"
          >
            Clear Completed ({completedCount})
          </button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-xs">
          <span className="font-medium text-destructive">{selected.size} job(s) selected</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="rounded-lg px-2.5 py-1 text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={bulkBusy}
              className="rounded-lg bg-destructive px-3 py-1 font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {bulkBusy ? "Deleting…" : `Delete Selected (${selected.size})`}
            </button>
          </div>
        </div>
      )}

      {err && <Card className="text-sm text-destructive">{err}</Card>}
      <div className="overflow-x-auto rounded-2xl bg-card">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-8 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={toggleSelectAll}
                  className="rounded border-border accent-primary cursor-pointer"
                />
              </th>
              {["Title", "TMDB", "Release", "Status", "Attempts", "Next retry", "Error", "Actions"].map((h) => (
                <th key={h} className={`px-4 py-3 font-medium ${h === "Actions" ? "text-right" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {seasonGroups.map((group) => {
              const expansionKey = `${group.key}:${group.defaultCollapsed}`;
              const expanded = seasonExpanded[expansionKey] ?? !group.defaultCollapsed;
              return (
                <Fragment key={group.key}>
                  {group.isTv && (
                    <tr className="border-t border-border bg-secondary/40">
                      <td colSpan={9} className="px-4 py-2">
                        <Button
                          variant="ghost"
                          className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Collapse" : "Expand"} ${group.title} Season ${group.season ?? 0}`}
                          onClick={() => setSeasonExpanded((prev) => ({ ...prev, [expansionKey]: !expanded }))}
                        >
                          <ChevronRight className={`size-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
                          <span className="min-w-0 break-words">{group.title} · Season {group.season ?? 0}</span>
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{group.completedCount}/{group.rows.length} completed</span>
                          {group.defaultCollapsed && <CheckCircle2 className="size-4 text-success" />}
                        </Button>
                      </td>
                    </tr>
                  )}
                  {expanded && group.rows.map((r) => (
              <tr key={r.id} className="border-t border-border align-top hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.title}`}
                    checked={selected.has(r.id)}
                    onChange={() => toggleSelectOne(r.id)}
                    className="rounded border-border accent-primary cursor-pointer"
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium">{r.title}</div>
                  <div className="text-xs text-muted-foreground">{r.media_type === "tv" ? "Series" : "Movie"}</div>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{r.tmdb_id}</td>
                <td className="px-4 py-3 whitespace-nowrap">{r.release_date ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className={`whitespace-nowrap rounded-lg px-2 py-1 text-xs font-medium ${STATUS_META[r.status]?.cls}`}>
                    {STATUS_META[r.status]?.label ?? r.status}
                  </span>
                  {r.status === "qa_waiting" && (
                    <div className="mt-1 text-[11px] font-mono tabular-nums text-info">{fmtCountdown(r.next_retry_at, clockNow)}</div>
                  )}
                </td>
                <td className="px-4 py-3 tabular-nums">{r.attempts}</td>
                <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">{fmt(r.next_retry_at)}</td>
                <td className={`max-w-64 px-4 py-3 text-xs ${r.status === "qa_waiting" ? "text-info" : "text-muted-foreground"}`}>
                  {r.status === "qa_waiting" ? "" : r.error_log ?? "—"}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-right">
                  <div className="flex items-center justify-end gap-2.5">
                    {(r.status === "completed" || r.status === "needs_review") && (
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={async () => setPreview({ title: r.title, text: await getPreview({ data: { key: k, id: r.id } }) })}
                      >
                        {r.status === "needs_review" ? "Review draft" : "Preview"}
                      </button>
                    )}
                    {(r.status === "failed" || r.status === "qa_waiting" || r.status === "needs_review" || r.status.startsWith("waiting")) && (
                      <button
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                        onClick={async () => { await retryJob({ data: { key: k, id: r.id } }); load(); }}
                      >
                        Retry
                      </button>
                    )}
                    <button
                      className="text-xs text-destructive hover:underline font-medium"
                      onClick={() => handleDeleteOne(r)}
                      disabled={busyId === r.id || bulkBusy}
                    >
                      {busyId === r.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </td>
              </tr>
                  ))}
                </Fragment>
              );
            })}
            {!rows.length && <tr><td colSpan={9} className="px-4 py-12 text-center text-muted-foreground">No jobs</td></tr>}
          </tbody>
        </table>
      </div>
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6" onClick={() => setPreview(null)}>
          <div className="w-full max-w-2xl rounded-2xl bg-popover p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><h3 className="font-semibold">{preview.title}</h3><button className="text-sm text-muted-foreground" onClick={() => setPreview(null)}>Close</button></div>
            <pre className="mt-4 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-xl bg-background p-4 font-mono text-xs">{preview.text || "No preview stored."}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

type UserRequest = {
  id: number | string;
  title: string;
  tmdb_id: number;
  type: "movie" | "tv";
  status: "pending" | "approved" | "completed" | "rejected";
  email: string;
  created_at: string;
  updated_at: string;
  poster_path?: string | null;
  release_date?: string | null;
  vote_average?: number | null;
  overview?: string | null;
};

function UserRequestsView({
  k,
  onProcess,
  onCountChange,
}: {
  k: string;
  onProcess: (req: UserRequest) => void;
  onCountChange?: (count: number) => void;
}) {
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<UserRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [actionId, setActionId] = useState<number | string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listUserRequests({ data: { key: k, status, q } })
      .then((r) => {
        setRows(r as UserRequest[]);
        setErr("");
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));

    getPendingRequestsCount({ data: { key: k } })
      .then((c) => onCountChange?.(c))
      .catch(() => {});
  }, [k, status, q, onCountChange]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const changeStatus = async (id: number | string, newStatus: "pending" | "approved" | "completed" | "rejected") => {
    setActionId(id);
    try {
      await updateUserRequestStatus({ data: { key: k, id, status: newStatus } });
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setActionId(null);
    }
  };

  const removeRequest = async (id: number | string) => {
    if (!confirm("Are you sure you want to delete this user request?")) return;
    setActionId(id);
    try {
      await deleteUserRequest({ data: { key: k, id } });
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setActionId(null);
    }
  };

  const pendingCount = rows.filter((r) => r.status === "pending").length;
  const completedCount = rows.filter((r) => r.status === "completed").length;
  const rejectedCount = rows.filter((r) => r.status === "rejected").length;

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-semibold tracking-tight">User Title Requests</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Movies and TV shows requested by viewers on OnFlix. 1-click to translate and publish.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="self-start sm:self-auto flex items-center gap-1.5 rounded-xl bg-card border border-border/40 px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-3">
        <div className="relative w-full sm:flex-1">
          <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, TMDB ID or user email…"
            className="w-full rounded-xl bg-card pl-10 pr-4 py-2.5 text-xs sm:text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex overflow-x-auto no-scrollbar gap-1 rounded-xl p-1 w-full sm:w-auto shrink-0">
          {[
            { id: "all", label: `All (${rows.length})` },
            { id: "pending", label: `Pending (${pendingCount})`, highlight: pendingCount > 0 },
            { id: "completed", label: `Completed (${completedCount})` },
            { id: "rejected", label: `Rejected (${rejectedCount})` },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setStatus(tab.id)}
              className={`whitespace-nowrap flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                status === tab.id
                  ? "bg-secondary text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span>{tab.label}</span>
              {tab.highlight && <span className="size-1.5 rounded-full bg-warning animate-pulse" />}
            </button>
          ))}
        </div>
      </div>

      {err && <Card className="text-sm text-destructive">{err}</Card>}

      {/* Requests Cards List */}
      <div className="grid gap-4 md:grid-cols-2">
        {rows.map((r) => {
          const isPending = r.status === "pending";
          const isCompleted = r.status === "completed";
          const isRejected = r.status === "rejected";

          return (
            <div
              key={r.id}
              className={`group flex flex-col justify-between rounded-2xl bg-card p-5 transition-all border ${
                isPending
                  ? "border-warning/30 hover:border-warning/60 shadow-sm"
                  : isCompleted
                  ? "border-success/20 hover:border-success/40"
                  : "border-border/40 hover:border-border"
              }`}
            >
              <div>
                <div className="flex items-start gap-4">
                  {/* Poster Thumbnail */}
                  {r.poster_path ? (
                    <img
                      src={`https://image.tmdb.org/t/p/w185${r.poster_path}`}
                      alt={r.title}
                      className="h-28 w-20 shrink-0 rounded-xl object-cover shadow-md bg-secondary"
                    />
                  ) : (
                    <div className="flex h-28 w-20 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
                      {r.type === "tv" ? <Tv className="size-7 opacity-40" /> : <Film className="size-7 opacity-40" />}
                    </div>
                  )}

                  {/* Title & Details */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase ${
                          r.type === "tv"
                            ? "bg-purple-500/15 text-purple-400 border border-purple-500/20"
                            : "bg-blue-500/15 text-blue-400 border border-blue-500/20"
                        }`}
                      >
                        {r.type === "tv" ? <Tv className="size-3" /> : <Film className="size-3" />}
                        {r.type === "tv" ? "Series" : "Movie"}
                      </span>

                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${
                          isPending
                            ? "bg-warning/15 text-warning border border-warning/30"
                            : isCompleted
                            ? "bg-success/15 text-success border border-success/30"
                            : isRejected
                            ? "bg-destructive/15 text-destructive border border-destructive/30"
                            : "bg-info/15 text-info border border-info/30"
                        }`}
                      >
                        {isPending && <Clock className="size-3" />}
                        {isCompleted && <CheckCircle2 className="size-3" />}
                        {isRejected && <XCircle className="size-3" />}
                        {r.status.toUpperCase()}
                      </span>
                    </div>

                    <h3 className="mt-1.5 text-base font-semibold text-foreground line-clamp-1">
                      {r.title}
                      {r.release_date ? (
                        <span className="ml-1.5 font-normal text-muted-foreground">({r.release_date.slice(0, 4)})</span>
                      ) : null}
                    </h3>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <a
                        href={`https://www.themoviedb.org/${r.type}/${r.tmdb_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline font-mono"
                      >
                        TMDB {r.tmdb_id}
                        <ExternalLink className="size-3" />
                      </a>

                      <span className="inline-flex items-center gap-1">
                        <Mail className="size-3" />
                        <span className="truncate max-w-40">{r.email}</span>
                      </span>

                      {r.vote_average ? (
                        <span className="text-amber-400 font-medium">★ {r.vote_average.toFixed(1)}</span>
                      ) : null}
                    </div>

                    {r.overview && (
                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground/80 leading-relaxed">
                        {r.overview}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Bottom Actions Bar */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-border/40">
                <span className="text-[11px] text-muted-foreground">
                  Requested {fmt(r.created_at)}
                </span>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Primary 1-Click Upload Action */}
                  <button
                    type="button"
                    onClick={() => onProcess(r)}
                    className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 shadow-sm transition-opacity"
                    title="1-Click process: probe video, translate subtitles and publish"
                  >
                    <Play className="size-3.5 fill-current" />
                    <span>Upload Now</span>
                  </button>

                  {/* Status Actions */}
                  {isPending && (
                    <>
                      <button
                        type="button"
                        disabled={actionId === r.id}
                        onClick={() => changeStatus(r.id, "completed")}
                        className="flex items-center gap-1 rounded-xl bg-secondary px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary/80 transition-colors"
                        title="Mark as completed without running engine"
                      >
                        <Check className="size-3 text-success" />
                        <span>Done</span>
                      </button>
                      <button
                        type="button"
                        disabled={actionId === r.id}
                        onClick={() => changeStatus(r.id, "rejected")}
                        className="flex items-center gap-1 rounded-xl bg-secondary px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-destructive transition-colors"
                        title="Reject request"
                      >
                        <XCircle className="size-3" />
                        <span>Reject</span>
                      </button>
                    </>
                  )}

                  {(isCompleted || isRejected) && (
                    <button
                      type="button"
                      disabled={actionId === r.id}
                      onClick={() => changeStatus(r.id, "pending")}
                      className="flex items-center gap-1 rounded-xl bg-secondary px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Clock className="size-3" />
                      <span>Re-open</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={actionId === r.id}
                    onClick={() => removeRequest(r.id)}
                    className="rounded-xl p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                    title="Delete request"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {!rows.length && !loading && (
        <Card className="py-12 text-center">
          <Mail className="mx-auto size-10 text-muted-foreground/40" />
          <h3 className="mt-3 text-sm font-semibold">No requests found</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {q ? "No requests match your search criteria." : "No user title requests submitted yet."}
          </p>
        </Card>
      )}
    </div>
  );
}

type S = Awaited<ReturnType<typeof loadSettings>>;
const FIELDS: [keyof S, string, string, "number" | "text"][] = [
  ["minPopularity", "Min popularity", "TMDB popularity score", "number"],
  ["minRating", "Min rating", "TMDB vote average (0–10); lower-rated titles are skipped", "number"],
  ["minVoteCount", "Min vote count", "Ignore titles with too few votes", "number"],
  ["minRuntime", "Min runtime (minutes)", "Excludes short films, clips, teasers", "number"],
  ["lookaheadDays", "Lookahead days", "How far ahead to discover upcoming releases", "number"],
  ["maxBatchSize", "Max batch size", "Jobs processed per run", "number"],
  ["maxScanJobs", "Max scan jobs", "New jobs added per scan (most popular first)", "number"],
  ["retryHours", "Retry interval (hours)", "Wait before rechecking a job", "number"],
  ["maxAttempts", "Max attempts", "Stop retrying after this many tries", "number"],
  ["embedProbeUrl", "EmbedMaster probe URL", "Blank = official EmbedMaster check API. Placeholders: {tmdb} {type} {season} {episode}", "text"],
  ["bucket", "Storage bucket", "Where Sinhala .srt files are uploaded", "text"],
  ["seriesTypeValue", "Series type value", "Value your content.type uses for series (default tv_show)", "text"],
  ["subdlApiKey", "SubDL API key", "Primary subtitle source — get free key from subdl.com", "text"],
  ["wyzieApiKey", "Wyzie API key", "Optional — from sub.wyzie.io/redeem (blank = WYZIE_API_KEY)", "text"],
  ["myMemoryEmail", "MyMemory email", "Sent as de= to MyMemory for a higher daily quota (blank = MYMEMORY_USER_EMAIL or default)", "text"],
  ["revalidateUrl", "Cache revalidation URL", "Optional — signed with REVALIDATE_SECRET (HMAC-SHA256)", "text"],
];

function SettingsView({ k }: { k: string }) {
  const [s, setS] = useState<S | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { loadSettings({ data: { key: k } }).then(setS).catch((e) => setMsg(e.message)); }, [k]);
  if (!s) return <Card className="text-sm text-muted-foreground">{msg || "Loading…"}</Card>;
  return (
    <Card>
      <div className="grid gap-5 md:grid-cols-2">
        {FIELDS.map(([f, l, h, t]) => (
          <label key={f} className={t === "text" ? "md:col-span-2" : ""}>
            <span className="text-sm font-medium">{l}</span>
            <input type={t} step="any" value={String(s[f])}
              onChange={(e) => setS({ ...s, [f]: t === "number" ? Number(e.target.value) : e.target.value })}
              className="mt-2 w-full rounded-xl bg-input px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
            <span className="mt-1 block text-xs text-muted-foreground">{h}</span>
          </label>
        ))}
      </div>
      <div className="mt-6 flex items-center gap-4">
        <button className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
          onClick={async () => { try { await updateSettings({ data: { key: k, settings: s } }); setMsg("Saved"); } catch (e) { setMsg((e as Error).message); } }}>Save settings</button>
        {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      </div>
      <p className="mt-6 text-xs text-muted-foreground">TV talk shows, news and reality series are always excluded.</p>
    </Card>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}
    className="rounded-lg bg-secondary px-3 py-1.5 text-xs font-medium">{done ? "Copied" : "Copy"}</button>;
}

function ApiView({ k }: { k: string }) {
  const [env, setEnv] = useState<Record<string, boolean>>({});
  const [origin, setOrigin] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ path: string; data: unknown } | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    getEnv({ data: { key: k } }).then(setEnv).catch(() => {});
  }, [k]);

  const testTrigger = async (path: string) => {
    setTesting(path);
    setTestResult(null);
    try {
      const res = await fetch(`${path}?secret=${encodeURIComponent(k)}`, { method: "POST" });
      const json = await res.json();
      setTestResult({ path, data: json });
    } catch (err) {
      setTestResult({ path, data: { error: (err as Error).message } });
    } finally {
      setTesting(null);
    }
  };

  const eps = [
    {
      name: "Queue Processor (Automatic Video & Subtitle Upload)",
      path: "/api/public/cron/process",
      schedule: "Every 10–15 minutes (or 5 minutes)",
      desc: "Checks 'Waiting for Video' items like S1E5. As soon as video embed is available, it automatically fetches English SRT, translates & polishes with Gemini pool, and publishes to OnFlix.",
    },
    {
      name: "Scanner & Content Discoverer",
      path: "/api/public/cron/scan",
      schedule: "Every 6–12 hours",
      desc: "Scans TMDB trending & upcoming releases to discover new movies and episodes, and adds them into the queue.",
    },
  ];

  return (
    <div className="space-y-4">
      {/* Explanation Banner */}
      <Card>
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5 text-primary shrink-0 mt-0.5">
            <RefreshCw className="size-4" />
          </div>
          <div className="space-y-1">
            <h3 className="font-semibold text-sm text-foreground">How 24/7 Automated Upload Works</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              When episodes are in <strong className="text-warning">"Waiting for Video"</strong>, your server already has the automation engine built in. By setting up a free cron job on <strong>cron-job.org</strong> calling the <strong>Queue Processor</strong> endpoint every 10–15 minutes, you don't even need to keep your browser open. The moment the video stream arrives, the cron job will automatically detect it, polish subtitles, and publish to OnFlix!
            </p>
          </div>
        </div>
      </Card>

      {/* Endpoints */}
      {eps.map((item) => {
        const fullUrlWithSecret = `${origin}${item.path}?secret=${encodeURIComponent(k)}`;
        return (
          <Card key={item.path}>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-sm text-foreground">{item.name}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className="text-[11px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-md">
                    Schedule: {item.schedule}
                  </span>
                  <span className="text-[11px] text-muted-foreground">HTTP GET or POST</span>
                </div>
              </div>

              <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
                <button
                  type="button"
                  onClick={() => testTrigger(item.path)}
                  disabled={testing === item.path}
                  className="rounded-xl bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/80 transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                >
                  <RefreshCw className={`size-3.5 ${testing === item.path ? "animate-spin text-primary" : ""}`} />
                  <span>{testing === item.path ? "Testing…" : "Test Trigger"}</span>
                </button>
                <Copy text={fullUrlWithSecret} />
              </div>
            </div>

            <div className="mt-3 space-y-1.5">
              <span className="text-[11px] text-muted-foreground font-medium">Cron URL (with secret for cron-job.org):</span>
              <code className="block overflow-x-auto rounded-xl bg-background p-3 font-mono text-xs text-foreground/90 select-all">
                {fullUrlWithSecret}
              </code>
            </div>

            {testResult?.path === item.path && (
              <div className="mt-3 rounded-xl bg-background/80 p-3 space-y-1">
                <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                  <span>Live Test Response:</span>
                  <button onClick={() => setTestResult(null)} className="hover:text-foreground">✕</button>
                </div>
                <pre className="font-mono text-[11px] text-success overflow-x-auto leading-relaxed">
                  {JSON.stringify(testResult.data, null, 2)}
                </pre>
              </div>
            )}
          </Card>
        );
      })}

      {/* Setup Instructions for cron-job.org */}
      <Card>
        <h3 className="font-semibold text-sm">Step-by-Step cron-job.org Setup (Option 1)</h3>
        <ol className="mt-3 space-y-2 text-xs text-muted-foreground list-decimal list-inside leading-relaxed">
          <li>Create a free account on <a href="https://cron-job.org" target="_blank" rel="noreferrer" className="text-primary underline">cron-job.org</a>.</li>
          <li>Click <strong>"Create Cronjob"</strong>.</li>
          <li>Title: e.g. <code className="bg-background px-1.5 py-0.5 rounded text-foreground font-mono">OnFlix Subtitle Processor</code></li>
          <li>URL: Paste the <strong>Queue Processor URL</strong> from the card above (it already contains your secret).</li>
          <li>Schedule: Choose <strong>"Every 10 minutes"</strong> or <strong>"Every 15 minutes"</strong>.</li>
          <li>Click <strong>"Create"</strong>. Now you are done! Even when your computer is off, it will automatically detect video embeds and publish subtitles.</li>
        </ol>
      </Card>

      {/* GitHub Actions Worker Guide */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm">GitHub Actions Cloud Worker (Option 2 — Zero Timeouts)</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Runs in dedicated GitHub Actions Ubuntu runners (up to 60 minutes runtime). Completely immune to serverless timeouts and cloud IP blocks.
            </p>
          </div>
          <span className="rounded-lg bg-primary/10 text-primary px-2.5 py-1 text-xs font-semibold">Zero Timeout</span>
        </div>
        <div className="mt-4 space-y-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Add these Secrets in GitHub: (Repo → Settings → Secrets and variables → Actions)</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px]">
            <div className="rounded-lg bg-background p-2 border border-border">VITE_SUPABASE_URL</div>
            <div className="rounded-lg bg-background p-2 border border-border">SUPABASE_SERVICE_ROLE_KEY</div>
            <div className="rounded-lg bg-background p-2 border border-border">CRON_SECRET</div>
            <div className="rounded-lg bg-background p-2 border border-border">GEMINI_API_KEY</div>
            <div className="rounded-lg bg-background p-2 border border-border">GEMINI_API_KEY_1, _2... (pool keys)</div>
            <div className="rounded-lg bg-background p-2 border border-border">SUBDL_API_KEY / WYZIE_API_KEY</div>
          </div>
          <p className="pt-1">
            <strong>Automatic Schedule:</strong> Already configured to run <strong>every 15 minutes</strong> via <code className="bg-background px-1 py-0.5 rounded font-mono">.github/workflows/process-queue.yml</code>. You can also click <strong>"Run workflow"</strong> manually in the Actions tab.
          </p>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-sm">Configuration status</h3>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {Object.entries(env).map(([n, ok]) => (
            <div key={n} className="flex items-center justify-between rounded-xl bg-background px-4 py-2.5">
              <span className="font-mono text-xs">{n}</span>
              <span className={`text-xs ${ok ? "text-success font-medium" : "text-muted-foreground"}`}>{ok ? "Set" : "Missing"}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}


// ─── AI Co-Pilot View ────────────────────────────────────────────────────────

type CopilotRole = "user" | "assistant" | "tool";

interface CollectionOption {
  id: string;
  name: string;
  description: string;
  tmdb_collection_id: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  items: Array<{ id: number; tmdb_id: number; title: string; type: string; year?: number | null; rating?: number | null }>;
  source_urls: string[];
}

interface CopilotMessage {
  id: string;
  role: CopilotRole;
  content: string;
  collectionOptions?: CollectionOption[] | undefined;
  selectedOptionId?: string;
  toolName?: string;
  toolResult?: unknown;
  isError?: boolean;
  timestamp: number;
}

const QUICK_ACTIONS = [
  { label: "Discover collection ideas", description: "Search the web and match ideas to published OnFlix titles", prompt: "I want collection ideas using both movies and TV shows. First inspect our published OnFlix catalog and search the web, then show me collection options to choose from. Do not create anything until I select one.", icon: "sparkles" },
  { label: "Auto-curate Top 10", description: "Rank Top 10 movies & series by highest rating", prompt: "Ape web eke published wela thiyena rating wadi films and tv shows balala Top 10 eka curate karala update karanna", icon: "sparkles" },
  { label: "Hero Slider (Top 7-8)", description: "Feature top 7-8 rated titles on homepage slider", prompt: "Hero slider eka manage karanna. Web eke thiyena rating wadi published titles walin uparimayen 7-8k witharak hero slider eke thiyanna (max 8).", icon: "star" },
  { label: "Top 10 content", description: "See current movie and TV rankings", prompt: "Show me the current Top 10 movies and TV shows", icon: "list" },
  { label: "Platform health", description: "Audit titles, subtitles, and system status", prompt: "Run a full platform health audit report of OnFlix", icon: "activity" },
  { label: "Check embed links", description: "Scan Top 10 for broken video sources", prompt: "Check if video embed links are healthy for the Top 10 movies", icon: "shield" },
  { label: "User requests", description: "Inspect titles users are waiting on", prompt: "What title requests are users waiting on?", icon: "users" },
] as const;

function CopilotView({ k }: { k: string }) {
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groqStatus, setGroqStatus] = useState<"unknown" | "ok" | "missing">("unknown");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Check if GROQ key is configured on server
  useEffect(() => {
    if (!k) return;
    fetch("/api/public/copilot/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: k, messages: [{ role: "user", content: "ping" }] }),
    }).then((r) => {
      if (r.status === 503) setGroqStatus("missing");
      else setGroqStatus("ok");
    }).catch(() => setGroqStatus("ok")); // network error ≠ missing key
  }, [k]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const buildHistoryForAPI = (msgs: CopilotMessage[]) =>
    msgs
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

  const sendMessage = async (text: string, selectedOption?: CollectionOption, optionMessageId?: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: CopilotMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };

    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/public/copilot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: k,
          messages: buildHistoryForAPI(nextMessages),
          ...(selectedOption ? { selected_collection_option: selectedOption } : {}),
        }),
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as {
        role: string;
        content: string;
        tool_results?: unknown[];
        collection_options?: CollectionOption[];
      };

      const assistantMsg: CopilotMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.content,
        collectionOptions: data.collection_options,
        timestamp: Date.now(),
      };
      setMessages((prev) => [
        ...prev.map((message) => message.id === optionMessageId && selectedOption
          ? { ...message, selectedOptionId: selectedOption.id }
          : message),
        assistantMsg,
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
    setInput("");
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  return (
    <div className="mx-auto flex min-h-[calc(100vh-13rem)] max-w-5xl flex-col">
      <header className="flex flex-wrap items-start justify-between gap-5 pb-7">
        <div>
         
        </div>
        <div className="flex items-center gap-3">
          <div
            role="status"
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ${
              groqStatus === "ok"
                ? "bg-success/10 text-success"
                : groqStatus === "missing"
                  ? "bg-warning/10 text-warning"
                  : "bg-secondary text-muted-foreground"
            }`}
          >
            <span className={`size-1.5 rounded-full ${
              groqStatus === "ok" ? "bg-success" : groqStatus === "missing" ? "bg-warning" : "bg-muted-foreground"
            }`} />
            {groqStatus === "ok" ? "Ready" : groqStatus === "missing" ? "Setup required" : "Connecting"}
          </div>
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="flex items-center gap-2 rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <RotateCcw size={14} />
              New chat
            </button>
          )}
        </div>
      </header>

      {groqStatus === "missing" && (
        <div className="mb-5 rounded-xl bg-warning/10 px-4 py-3 text-sm leading-6 text-warning">
          <span className="font-semibold">AI API Key</span> is not configured. Add <code className="rounded bg-warning/20 px-1 font-mono text-xs">GROQ_API_KEY</code>, <code className="rounded bg-warning/20 px-1 font-mono text-xs">GITHUB_TOKEN</code>, or <code className="rounded bg-warning/20 px-1 font-mono text-xs">OPENROUTER_API_KEY</code> to your <code className="rounded bg-warning/20 px-1 font-mono text-xs">.env</code> file.
        </div>
      )}

      <section className="flex flex-1 flex-col rounded-3xl px-4 py-5 sm:px-8 sm:py-7">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col justify-center py-8 sm:py-12">
            <div className="mx-auto w-full max-w-2xl">
              <div className="mb-8 flex items-start gap-4">
               
                <div>
                  <p className="text-lg font-semibold tracking-tight">What would you like to manage?</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Ask a question or choose a starting point. I can help you review OnFlix data and take action.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 min-[480px]:grid-cols-2 gap-2">
                {QUICK_ACTIONS.map((qa) => (
                  <button
                    key={qa.label}
                    onClick={() => void sendMessage(qa.prompt)}
                    disabled={loading || groqStatus === "missing"}
                    className="group flex min-h-[58px] sm:min-h-16 items-center gap-2.5 sm:gap-3 rounded-2xl bg-secondary/65 px-3 py-2.5 sm:px-4 sm:py-3 text-left transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                  >
                    <span className="flex size-8 sm:size-9 shrink-0 items-center justify-center rounded-xl bg-background/70 text-muted-foreground transition-colors group-hover:text-primary">
                      {qa.icon === "list" && <List size={16} />}
                      {qa.icon === "star" && <Star size={16} />}
                      {qa.icon === "activity" && <Activity size={16} />}
                      {qa.icon === "shield" && <ShieldCheck size={16} />}
                      {qa.icon === "users" && <Users size={16} />}
                      {qa.icon === "sparkles" && <Sparkles size={16} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs sm:text-sm font-medium text-foreground truncate">{qa.label}</span>
                      <span className="mt-0.5 block text-[11px] sm:text-xs leading-4 sm:leading-5 text-muted-foreground line-clamp-1 sm:line-clamp-2">{qa.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-7 py-2">
            {messages.map((msg) => (
              <ChatBubble
                key={msg.id}
                msg={msg}
                busy={loading}
                onSelectCollection={(option) => void sendMessage(`Create the selected collection: ${option.name}`, option, msg.id)}
              />
            ))}
            {loading && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
                <span className="flex gap-1">
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
                </span>
                Thinking…
              </div>
            )}
            {error && (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm leading-6 text-destructive" role="alert">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => {
                    const lastUser = [...messages].reverse().find((m) => m.role === "user");
                    if (lastUser) void sendMessage(lastUser.content);
                  }}
                  className="shrink-0 rounded-lg bg-destructive/20 px-3 py-1 text-xs font-semibold hover:bg-destructive/30 transition-colors cursor-pointer"
                >
                  Retry
                </button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}

        <div className="mx-auto w-full max-w-3xl shrink-0 pt-3 sm:pt-5">
          <div className="rounded-2xl bg-secondary/70 transition-colors focus-within:bg-secondary">
            <div className="flex items-end gap-2 sm:gap-3 p-2 pt-2 sm:p-3">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={handleKeyDown}
                placeholder="Ask Anthing"
                aria-label="Message the OnFlix assistant"
                rows={1}
                disabled={loading || groqStatus === "missing"}
                className="min-h-11 sm:min-h-12 flex-1 resize-none bg-transparent px-2.5 sm:px-3 py-2 sm:py-3 text-[14.5px] sm:text-[15.5px] leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:opacity-40 no-scrollbar"
                style={{ maxHeight: "160px" }}
              />
              <button
                onClick={() => void sendMessage(input)}
                disabled={!input.trim() || loading || groqStatus === "missing"}
                aria-label="Send message"
                className="flex size-9 sm:size-10 shrink-0 items-center justify-center rounded-[13px] bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              >
                <ArrowUp size={16} />
              </button>
            </div>
          </div>
          <p className="pt-2 sm:pt-3 text-center text-[10px] sm:text-xs text-muted-foreground/70">
            Enter to send <span className="hidden sm:inline">· Shift+Enter for a new line</span> · Multi-Provider Auto-Failover (Groq / GitHub / OpenRouter)
          </p>
        </div>
      </section>
    </div>
  );
}

function ChatBubble({
  msg,
  busy,
  onSelectCollection,
}: {
  msg: CopilotMessage;
  busy: boolean;
  onSelectCollection: (option: CollectionOption) => void;
}) {
  const isUser = msg.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-[15.5px] leading-7 text-foreground whitespace-pre-wrap sm:max-w-[75%]">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="flex max-w-full gap-3 sm:max-w-[90%]">
        
        <div className="min-w-0 pt-1 text-[15.5px] leading-7">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">OnFlix assistant</p>
          <div className="text-foreground/90">
            <MarkdownLite text={msg.content} />
          </div>
          {msg.collectionOptions && msg.collectionOptions.length > 0 && (
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {msg.collectionOptions.map((option) => {
                const selected = msg.selectedOptionId === option.id;
                return (
                  <article key={option.id} className="overflow-hidden rounded-lg bg-secondary/60 ring-1 ring-border/60">
                    <div className="relative aspect-[16/8] overflow-hidden bg-secondary">
                      {option.backdrop_url && (
                        <img src={option.backdrop_url} alt="" className="absolute inset-0 size-full object-cover" loading="lazy" />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-black/10" />
                      {option.poster_url && (
                        <img
                          src={option.poster_url}
                          alt={`${option.name} poster`}
                          className="absolute bottom-3 left-3 aspect-[2/3] w-14 rounded-md object-cover shadow-md sm:w-16"
                          loading="lazy"
                        />
                      )}
                      <div className={`absolute bottom-3 right-3 ${option.poster_url ? "left-20 sm:left-24" : "left-3"}`}>
                        <p className="text-xs font-medium text-white/80">{option.items.length} published OnFlix titles</p>
                        {option.tmdb_collection_id && <p className="mt-0.5 text-[10px] text-white/65">TMDB collection</p>}
                      </div>
                    </div>
                    <div className="space-y-3 p-4">
                      <div>
                        <h3 className="text-base font-semibold leading-6 text-foreground">{option.name}</h3>
                        <p className="mt-1 text-sm leading-5 text-muted-foreground">{option.description}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase text-muted-foreground">Included titles</p>
                        <p className="mt-1 text-xs leading-5 text-foreground/80">
                          {option.items.slice(0, 5).map((item) => item.title).join(" · ")}
                          {option.items.length > 5 ? ` · +${option.items.length - 5} more` : ""}
                        </p>
                      </div>
                      {option.source_urls.length > 0 && (
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          {option.source_urls.slice(0, 3).map((url) => (
                            <a key={url} href={url} target="_blank" rel="noreferrer" className="text-xs text-primary underline-offset-4 hover:underline">
                              Source
                            </a>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelectCollection(option)}
                        disabled={busy || Boolean(msg.selectedOptionId)}
                        className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        {selected ? <Check size={15} /> : <Sparkles size={15} />}
                        {selected ? "Collection created" : "Create this collection"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function MarkdownLite({ text }: { text: string }) {
  if (!text) return <span className="text-muted-foreground italic">…</span>;

  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // 1. Markdown Table detection
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && (lines[i]?.trim().startsWith("|") && lines[i]?.trim().endsWith("|"))) {
        tableLines.push(lines[i]!.trim());
        i++;
      }

      if (tableLines.length >= 2) {
        const headerCells = parseTableRow(tableLines[0]!);
        const isSecondSep = isSeparatorRow(parseTableRow(tableLines[1]!));
        const dataRows = isSecondSep ? tableLines.slice(2) : tableLines.slice(1);

        elements.push(
          <div key={key++} className="my-3 overflow-x-auto no-scrollbar rounded-xl bg-secondary/50 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <table className="w-full text-left text-[13.5px] sm:text-[14px]">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  {headerCells.map((h, hIdx) => (
                    <th key={hIdx} className="px-3.5 py-2.5 font-semibold text-[13px] sm:text-[13.5px]">
                      {renderInline(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/25">
                {dataRows.map((dRow, rIdx) => {
                  const cells = parseTableRow(dRow);
                  return (
                    <tr key={rIdx} className="hover:bg-secondary/40 transition-colors">
                      {cells.map((c, cIdx) => (
                        <td key={cIdx} className="px-3.5 py-2.5 text-foreground/90 leading-relaxed">
                          {renderInline(c)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }
    }

    // 2. Fenced code block
    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]?.trim().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++;
      elements.push(
        <pre key={key++} className="my-2.5 overflow-x-auto rounded-xl bg-secondary/70 p-3 font-mono text-[13px] leading-relaxed text-muted-foreground">
          {codeLines.join("\n")}
        </pre>,
      );
      continue;
    }

    // 3. Headings
    if (line.startsWith("### ")) {
      elements.push(<p key={key++} className="mt-4 mb-1 text-xs font-semibold uppercase tracking-widest text-muted-foreground">{line.slice(4)}</p>);
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(<p key={key++} className="mt-4 mb-1.5 text-base font-semibold text-foreground">{line.slice(3)}</p>);
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      elements.push(<p key={key++} className="mt-4 mb-2 text-lg font-bold text-foreground">{line.slice(2)}</p>);
      i++;
      continue;
    }

    // 4. Bullet list
    if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <div key={key++} className="flex gap-2.5 py-1 text-[15.5px] leading-7">
          <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
          <span>{renderInline(line.slice(2))}</span>
        </div>,
      );
      i++;
      continue;
    }

    // 5. Numbered list
    if (/^\d+\. /.test(line)) {
      const num = line.match(/^(\d+)\. /)?.[1];
      elements.push(
        <div key={key++} className="flex gap-2.5 py-1 text-[15.5px] leading-7">
          <span className="shrink-0 text-sm font-medium text-muted-foreground tabular-nums">{num}.</span>
          <span>{renderInline(line.replace(/^\d+\. /, ""))}</span>
        </div>,
      );
      i++;
      continue;
    }

    // 6. Empty line
    if (trimmed === "") {
      elements.push(<div key={key++} className="h-2" />);
      i++;
      continue;
    }

    // 7. Normal paragraph
    elements.push(<p key={key++} className="py-1 text-[15.5px] leading-7">{renderInline(line)}</p>);
    i++;
  }

  return <div className="space-y-0">{elements}</div>;
}

function renderInline(text: string): React.ReactNode {
  // Bold: **text**, Inline code: `text`
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="rounded bg-secondary px-1 font-mono text-xs">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}
