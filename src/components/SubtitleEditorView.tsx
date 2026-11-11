import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Search, Play, Pause, RotateCcw, Download, Save, FastForward,
  Rewind, Clock, FileText, Check, AlertCircle, RefreshCw, Film, Tv,
  ArrowRight, Sparkles, SlidersHorizontal, CheckCircle2
} from "lucide-react";
import {
  listEditableSubtitles,
  getSubtitleForEdit,
  saveEditedSubtitle,
} from "@/lib/admin.functions";
import {
  parseSrt,
  stringifySrt,
  shiftCues,
  replaceTextInCues,
  timeStringToMs,
  msToTimeString,
  type SrtCue,
} from "@/lib/srt-utils";

type SubtitleJobItem = {
  id: string;
  tmdb_id: number;
  media_type: "movie" | "tv";
  title: string;
  season_number?: number | null;
  episode_number?: number | null;
  status: string;
  srt_url?: string | null;
  updated_at: string;
};

export function SubtitleEditorView({ k }: { k: string }) {
  // Search & Selector State
  const [query, setQuery] = useState("");
  const [recentJobs, setRecentJobs] = useState<SubtitleJobItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedJob, setSelectedJob] = useState<SubtitleJobItem | null>(null);

  // Editor State
  const [rawOriginalSrt, setRawOriginalSrt] = useState("");
  const [cues, setCues] = useState<SrtCue[]>([]);
  const [loadingSrt, setLoadingSrt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [err, setErr] = useState("");
  const [cumulativeOffsetMs, setCumulativeOffsetMs] = useState(0);

  // Search & Replace State
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [replaceStatus, setReplaceStatus] = useState<string | null>(null);

  // Player / Timeline Simulation State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const playIntervalRef = useRef<number | null>(null);
  const activeCueRef = useRef<HTMLDivElement | null>(null);

  // Load recent subtitle jobs list
  const loadRecent = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await listEditableSubtitles({ data: { key: k, q: query } });
      setRecentJobs(res as SubtitleJobItem[]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, [k, query]);

  useEffect(() => {
    const t = setTimeout(loadRecent, 300);
    return () => clearTimeout(t);
  }, [loadRecent]);

  // Load specific subtitle for editing
  const loadSubtitle = async (job: SubtitleJobItem) => {
    setSelectedJob(job);
    setLoadingSrt(true);
    setErr("");
    setSaveSuccess(false);
    setCumulativeOffsetMs(0);
    setIsPlaying(false);
    setCurrentTimeMs(0);

    try {
      const res = await getSubtitleForEdit({ data: { key: k, jobId: job.id } });
      const raw = res.srtContent || "";
      setRawOriginalSrt(raw);
      const parsed = parseSrt(raw);
      setCues(parsed);
      if (parsed.length > 0) {
        setCurrentTimeMs(parsed[0]?.startMs ?? 0);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingSrt(false);
    }
  };

  // Timeline Player Simulation
  useEffect(() => {
    if (isPlaying) {
      const step = 250;
      playIntervalRef.current = window.setInterval(() => {
        setCurrentTimeMs((prev) => {
          const maxMs = cues.length > 0 ? (cues[cues.length - 1]?.endMs ?? 0) + 2000 : 0;
          if (prev >= maxMs) {
            setIsPlaying(false);
            return 0;
          }
          return prev + step;
        });
      }, step);
    } else {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    }
    return () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    };
  }, [isPlaying, cues]);

  // Find active cue at current playback time
  const currentActiveCue = cues.find(
    (c) => currentTimeMs >= c.startMs && currentTimeMs <= c.endMs
  );

  // Apply Bulk Time Offset
  const handleApplyShift = (offsetMs: number) => {
    if (!cues.length) return;
    const shifted = shiftCues(cues, offsetMs);
    setCues(shifted);
    setCumulativeOffsetMs((prev) => prev + offsetMs);
    setSaveSuccess(false);
  };

  // Search & Replace
  const handleReplace = () => {
    if (!findText.trim() || !cues.length) return;
    const { cues: updated, count } = replaceTextInCues(cues, findText, replaceText, false);
    setCues(updated);
    setReplaceStatus(`Replaced ${count} occurrence${count === 1 ? "" : "s"}`);
    setSaveSuccess(false);
    setTimeout(() => setReplaceStatus(null), 3000);
  };

  // Update specific cue text
  const handleCueTextChange = (cueId: number, newText: string) => {
    setCues((prev) =>
      prev.map((c) => (c.id === cueId ? { ...c, text: newText } : c))
    );
    setSaveSuccess(false);
  };

  // Adjust specific cue start/end by +/- 100ms
  const handleIndividualCueShift = (cueId: number, deltaMs: number) => {
    setCues((prev) =>
      prev.map((c) => {
        if (c.id !== cueId) return c;
        const startMs = Math.max(0, c.startMs + deltaMs);
        const endMs = Math.max(startMs + 500, c.endMs + deltaMs);
        return {
          ...c,
          startMs,
          endMs,
          startTime: msToTimeString(startMs),
          endTime: msToTimeString(endMs),
        };
      })
    );
    setSaveSuccess(false);
  };

  // Save changes to Supabase storage & DB
  const handleSave = async () => {
    if (!selectedJob || !cues.length) return;
    setSaving(true);
    setErr("");
    try {
      const fullSrt = stringifySrt(cues);
      await saveEditedSubtitle({ data: { key: k, jobId: selectedJob.id, srtContent: fullSrt } });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 4000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Download SRT locally
  const handleDownload = () => {
    if (!cues.length || !selectedJob) return;
    const fullSrt = stringifySrt(cues);
    const blob = new Blob([fullSrt], { type: "application/x-subrip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedJob.title.replace(/[^\w.-]/g, "_")}_si.srt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Reset to original SRT
  const handleReset = () => {
    if (!confirm("Revert all edits and time-shifts back to original?")) return;
    setCues(parseSrt(rawOriginalSrt));
    setCumulativeOffsetMs(0);
    setSaveSuccess(false);
  };

  return (
    <div className="space-y-6">
      {/* View Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-semibold tracking-tight">Subtitle Preview & Quick Sync Editor</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Inspect Sinhala subtitles side-by-side, shift timing offsets (+/- seconds), fix wording, and publish live.
          </p>
        </div>

        {selectedJob && (
          <button
            type="button"
            onClick={() => setSelectedJob(null)}
            className="self-start sm:self-auto rounded-xl bg-card border border-border/40 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            ← Select another title
          </button>
        )}
      </div>

      {err && (
        <div className="rounded-2xl bg-destructive/10 p-4 text-xs text-destructive flex items-center justify-between">
          <span>{err}</span>
          <button onClick={() => setErr("")} className="font-semibold underline">Dismiss</button>
        </div>
      )}

      {saveSuccess && (
        <div className="rounded-2xl bg-success/10 p-4 text-xs text-success flex items-center gap-2">
          <CheckCircle2 className="size-4 shrink-0" />
          <span>Subtitle successfully synchronized, uploaded to Storage, and updated on OnFlix!</span>
        </div>
      )}

      {/* STEP 1: Search & Picker if no job selected */}
      {!selectedJob ? (
        <div className="rounded-2xl bg-card p-4 sm:p-6 space-y-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by movie title, series name, or TMDB ID…"
                className="w-full rounded-xl bg-background/60 pl-10 pr-4 py-2.5 text-xs sm:text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              onClick={loadRecent}
              disabled={loadingList}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-secondary px-4 py-2.5 text-xs font-medium text-foreground hover:bg-secondary/80 transition-colors"
            >
              <RefreshCw className={`size-3.5 ${loadingList ? "animate-spin" : ""}`} />
              <span>Refresh Titles</span>
            </button>
          </div>

          <div className="space-y-1.5 pt-2">
            <p className="text-xs font-medium text-muted-foreground">Select a subtitle to open in editor:</p>
            {loadingList ? (
              <div className="py-12 text-center text-xs text-muted-foreground">Loading available subtitles…</div>
            ) : recentJobs.length === 0 ? (
              <div className="py-12 text-center text-xs text-muted-foreground">
                No subtitles found matching search. Run an automation job first.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-1">
                {recentJobs.map((j) => (
                  <button
                    key={j.id}
                    onClick={() => void loadSubtitle(j)}
                    className="flex flex-col text-left rounded-xl bg-secondary/50 p-3.5 transition-all hover:bg-secondary hover:border-primary/40 cursor-pointer group"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-xs sm:text-sm text-foreground group-hover:text-primary transition-colors line-clamp-1">
                        {j.title}
                      </span>
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium bg-muted text-muted-foreground uppercase">
                        {j.media_type}
                      </span>
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>
                        TMDB #{j.tmdb_id}
                        {j.media_type === "tv" && j.season_number != null ? ` · S${j.season_number} E${j.episode_number}` : ""}
                      </span>
                      <span className="text-primary font-medium flex items-center gap-1 group-hover:translate-x-0.5 transition-transform">
                        Open Editor <ArrowRight className="size-3" />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* STEP 2: Active Editor & Live Preview */
        <div className="space-y-4">
          {/* Active Title Banner */}
          <div className="rounded-2xl bg-card p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                {selectedJob.media_type === "movie" ? <Film className="size-5" /> : <Tv className="size-5" />}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base sm:text-lg font-semibold text-foreground">{selectedJob.title}</h3>
                  <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-muted text-muted-foreground uppercase">
                    {selectedJob.media_type}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  TMDB ID: {selectedJob.tmdb_id}
                  {selectedJob.season_number != null ? ` · Season ${selectedJob.season_number} Episode ${selectedJob.episode_number}` : ""}
                  {" · "}{cues.length} total cues parsed
                  {cumulativeOffsetMs !== 0 && (
                    <span className="ml-2 font-mono font-semibold text-primary">
                      (Shift: {cumulativeOffsetMs > 0 ? `+${(cumulativeOffsetMs / 1000).toFixed(2)}s` : `${(cumulativeOffsetMs / 1000).toFixed(2)}s`})
                    </span>
                  )}
                </p>
              </div>
            </div>

            {/* Main Action Buttons */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleReset}
                className="rounded-xl bg-secondary px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                title="Revert to original"
              >
                <RotateCcw className="size-3.5 inline mr-1" /> Reset
              </button>
              <button
                type="button"
                onClick={handleDownload}
                className="rounded-xl bg-secondary px-3.5 py-2 text-xs font-medium text-foreground hover:text-primary transition-colors cursor-pointer flex items-center gap-1.5"
                title="Download .SRT file"
              >
                <Download className="size-3.5" /> Download .SRT
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-opacity disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
              >
                <Save className="size-3.5" />
                <span>{saving ? "Publishing…" : "Save & Update OnFlix"}</span>
              </button>
            </div>
          </div>

          {/* Quick Sync & Time Shift Controls */}
          <div className="rounded-2xl bg-card p-4 sm:p-5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Clock className="size-3.5 text-primary" />
                <span>Quick Time Shift (Sync Audio/Video)</span>
              </span>
              <span className="text-[11px] text-muted-foreground">
                One-click shifts all subtitles forward or backward without breaking formatting.
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 pt-1">
              {/* Backward buttons */}
              <button
                onClick={() => handleApplyShift(-5000)}
                className="rounded-xl bg-secondary px-3 py-1.5 text-xs font-mono font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors cursor-pointer"
              >
                -5.0s
              </button>
              <button
                onClick={() => handleApplyShift(-2000)}
                className="rounded-xl bg-secondary px-3 py-1.5 text-xs font-mono font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors cursor-pointer"
              >
                -2.0s
              </button>
              <button
                onClick={() => handleApplyShift(-1000)}
                className="rounded-xl bg-secondary px-3 py-1.5 text-xs font-mono font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors cursor-pointer"
              >
                -1.0s
              </button>
              <button
                onClick={() => handleApplyShift(-500)}
                className="rounded-xl bg-secondary px-3 py-1.5 text-xs font-mono font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors cursor-pointer"
              >
                -0.5s
              </button>

              <div className="h-5 w-px bg-border/40 mx-1 hidden sm:block" />

              {/* Forward buttons */}
              <button
                onClick={() => handleApplyShift(500)}
                className="rounded-xl bg-secondary px-3 py-1.5 text-xs font-mono font-medium text-muted-foreground hover:text-primary hover:bg-secondary/80 transition-colors cursor-pointer"
              >
                +0.5s
              </button>
              <button
                onClick={() => handleApplyShift(1000)}
                className="rounded-xl bg-secondary px-3 py-1.5 text-xs font-mono font-medium text-muted-foreground hover:text-primary hover:bg-secondary/80 transition-colors cursor-pointer"
              >
                +1.0s
              </button>
              <button
                onClick={() => handleApplyShift(2000)}
                className="rounded-xl bg-secondary px-3 py-1.5 text-xs font-mono font-medium text-muted-foreground hover:text-primary hover:bg-secondary/80 transition-colors cursor-pointer"
              >
                +2.0s
              </button>
              <button
                onClick={() => handleApplyShift(5000)}
                className="rounded-xl bg-secondary px-3 py-1.5 text-xs font-mono font-medium text-muted-foreground hover:text-primary hover:bg-secondary/80 transition-colors cursor-pointer"
              >
                +5.0s
              </button>
            </div>
          </div>

          {/* Search & Replace Bar */}
          <div className="rounded-2xl bg-card p-4 sm:p-5 space-y-3">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-primary" />
              <span>Search & Replace in Sinhala Subtitles</span>
            </span>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <input
                value={findText}
                onChange={(e) => setFindText(e.target.value)}
                placeholder="Find word (e.g. වැරදි නම)…"
                className="flex-1 rounded-xl bg-background/60 px-3.5 py-2 text-xs sm:text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                placeholder="Replace with (e.g. හරි නම)…"
                className="flex-1 rounded-xl bg-background/60 px-3.5 py-2 text-xs sm:text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={handleReplace}
                className="rounded-xl bg-secondary px-4 py-2 text-xs font-medium text-foreground hover:bg-primary hover:text-primary-foreground transition-colors cursor-pointer"
              >
                Replace All
              </button>
            </div>

            {replaceStatus && (
              <p className="text-xs font-medium text-primary animate-in fade-in duration-200">
                {replaceStatus}
              </p>
            )}
          </div>

          {/* Timeline Scrub & Preview Simulation */}
          <div className="rounded-2xl bg-card p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Play className="size-3.5 text-primary" />
                <span>Live Subtitle Playback Preview</span>
              </span>
              <span className="font-mono text-xs text-primary font-semibold tabular-nums">
                {msToTimeString(currentTimeMs)}
              </span>
            </div>

            {/* Current Active Cue Banner */}
            <div className="min-h-14 rounded-xl bg-background/60 p-3 flex items-center justify-center text-center">
              {currentActiveCue ? (
                <p className="text-sm sm:text-base font-medium text-primary transition-all">
                  "{currentActiveCue.text}"
                </p>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  (No subtitle dialogue active at this timestamp)
                </p>
              )}
            </div>

            {/* Playback Controls & Scrubber */}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => setIsPlaying(!isPlaying)}
                className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <Pause className="size-4" /> : <Play className="size-4 fill-current ml-0.5" />}
              </button>

              <input
                type="range"
                min={0}
                max={cues.length > 0 ? (cues[cues.length - 1]?.endMs ?? 1000) : 1000}
                value={currentTimeMs}
                onChange={(e) => {
                  setCurrentTimeMs(Number(e.target.value));
                  setIsPlaying(false);
                }}
                className="w-full accent-primary cursor-pointer"
              />
            </div>
          </div>

          {/* STEP 3: Subtitle Cues Editor List */}
          <div className="rounded-2xl bg-card p-4 sm:p-6 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs sm:text-sm font-semibold text-foreground">
                Subtitle Dialogue Lines ({cues.length} cues)
              </h4>
              <span className="text-[11px] text-muted-foreground">Click text to edit directly</span>
            </div>

            <div className="space-y-2 max-h-[600px] overflow-y-auto no-scrollbar pr-1 pt-2">
              {cues.map((cue) => {
                const isActive = currentTimeMs >= cue.startMs && currentTimeMs <= cue.endMs;
                return (
                  <div
                    key={cue.id}
                    ref={isActive ? activeCueRef : null}
                    className={`rounded-xl p-3 transition-colors ${
                      isActive ? "bg-secondary/90 border border-primary/40 shadow-xs" : "bg-background/40 hover:bg-background/60"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded-md bg-background/80 px-2 py-0.5 text-[10px] font-mono text-muted-foreground font-semibold">
                          #{cue.id}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setCurrentTimeMs(cue.startMs);
                            setIsPlaying(true);
                          }}
                          className="font-mono text-xs text-primary hover:underline cursor-pointer tabular-nums"
                          title="Jump to this cue in timeline"
                        >
                          {cue.startTime} ➔ {cue.endTime}
                        </button>
                      </div>

                      {/* Per-Cue nudge buttons */}
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <button
                          onClick={() => handleIndividualCueShift(cue.id, -100)}
                          className="rounded px-1.5 py-0.5 bg-secondary hover:text-foreground cursor-pointer"
                          title="Shift this cue 100ms earlier"
                        >
                          -100ms
                        </button>
                        <button
                          onClick={() => handleIndividualCueShift(cue.id, 100)}
                          className="rounded px-1.5 py-0.5 bg-secondary hover:text-foreground cursor-pointer"
                          title="Shift this cue 100ms later"
                        >
                          +100ms
                        </button>
                      </div>
                    </div>

                    <textarea
                      value={cue.text}
                      onChange={(e) => handleCueTextChange(cue.id, e.target.value)}
                      rows={cue.text.split("\n").length || 1}
                      className="w-full resize-none rounded-lg bg-transparent px-2 py-1.5 text-xs sm:text-sm leading-relaxed text-foreground outline-none focus:bg-background/60 focus:ring-1 focus:ring-primary/40 no-scrollbar"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
