import React from "react";

export type PolishWorker = {
  id: number;
  status: "idle" | "active" | "retrying" | "cooldown" | "completed";
  currentChunk?: number | undefined;
  startCue?: number | undefined;
  endCue?: number | undefined;
  cuesDone: number;
};

export type PolishChunk = {
  id: number;
  startCue: number;
  endCue: number;
  status: "pending" | "processing" | "done" | "retrying";
  workerId?: number | undefined;
};

export type PolishVisualState = {
  totalChunks: number;
  totalCues: number;
  workerCount: number;
  active: boolean;
  completed: boolean;
  workers: PolishWorker[];
  chunks: PolishChunk[];
};

interface PolishVisualizerProps {
  state: PolishVisualState;
  percent: number;
  elapsed: number;
  eta: number | null;
  fmtTime: (ms: number) => string;
}

export function PolishVisualizer({ state, percent, elapsed, eta, fmtTime }: PolishVisualizerProps) {
  const activeWorkersCount = state.workers.filter((w) => w.status === "active" || w.status === "retrying").length;
  const completedChunks = state.chunks.filter((c) => c.status === "done").length;
  const totalWorkers = Math.max(state.workerCount, state.workers.length, 1);
  const doneCues = state.workers.reduce((acc, w) => acc + w.cuesDone, 0);
  const totalCues = state.totalCues || 0;

  return (
    <div className="mt-2 space-y-3 animate-in fade-in duration-300">
      {/* Clean progress bar matching the rest of the workflow steps */}
      <div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span>
            {totalCues ? `${doneCues} / ${totalCues} cues` : `${completedChunks} / ${state.chunks.length} chunks`}
            {state.completed ? (
              <span className="ml-2 font-medium text-success">✓ Completed</span>
            ) : (
              <span className="ml-2 font-normal">
                · {activeWorkersCount} of {totalWorkers} workers active
              </span>
            )}
          </span>
          <span>
            {fmtTime(elapsed)} elapsed{eta != null && !state.completed ? ` · ~${fmtTime(eta)} left` : ""}
          </span>
        </div>
      </div>

      {/* Segmented Chunk Flow Bar */}
      {state.chunks.length > 0 && (
        <div className="flex gap-1 overflow-x-auto no-scrollbar py-0.5">
          {state.chunks.map((chunk) => {
            const isDone = chunk.status === "done" || state.completed;
            const isProcessing = chunk.status === "processing";
            const isRetrying = chunk.status === "retrying";

            return (
              <div
                key={chunk.id}
                title={`Part ${chunk.id + 1}${chunk.startCue ? `: Cues ${chunk.startCue}–${chunk.endCue}` : ""}${chunk.workerId ? ` (Worker ${chunk.workerId})` : ""}`}
                className={`h-1.5 min-w-[8px] flex-1 rounded-full transition-colors duration-300 ${
                  isDone
                    ? "bg-primary"
                    : isProcessing
                    ? "bg-primary/50 animate-pulse"
                    : isRetrying
                    ? "bg-warning"
                    : "bg-muted"
                }`}
              />
            );
          })}
        </div>
      )}

      {/* Clean, borderless Workers Grid matching OnFlix design */}
      <div className="grid grid-cols-2 min-[420px]:grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1.5 sm:gap-2">
        {state.workers.map((worker) => {
          const isActive = worker.status === "active";
          const isRetrying = worker.status === "retrying";
          const isDone = worker.status === "completed" || state.completed;
          const isCooldown = worker.status === "cooldown";

          return (
            <div
              key={worker.id}
              className={`rounded-xl p-2 sm:p-2.5 transition-colors duration-200 ${
                isActive
                  ? "bg-secondary"
                  : isRetrying
                  ? "bg-warning/10"
                  : isDone
                  ? "bg-secondary/40"
                  : "bg-background/40"
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] sm:text-xs font-medium text-foreground truncate">
                  Worker {worker.id}
                </span>
                <span
                  className={`rounded-md px-1.5 py-0.5 text-[9px] sm:text-[10px] font-medium tabular-nums shrink-0 ${
                    isActive
                      ? "bg-primary/20 text-primary"
                      : isRetrying
                      ? "bg-warning/20 text-warning"
                      : isDone
                      ? "bg-success/20 text-success"
                      : isCooldown
                      ? "bg-muted text-muted-foreground"
                      : "bg-muted/50 text-muted-foreground"
                  }`}
                >
                  {isActive
                    ? worker.startCue && worker.endCue
                      ? `${worker.startCue}–${worker.endCue}`
                      : "Active"
                    : isRetrying
                    ? "Rotating"
                    : isDone
                    ? "Done"
                    : isCooldown
                    ? "Pause"
                    : "Ready"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] sm:text-[11px] tabular-nums text-muted-foreground">
                <span>{worker.cuesDone > 0 ? `${worker.cuesDone} cues` : "0 cues"}</span>
                {isActive && (
                  <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
