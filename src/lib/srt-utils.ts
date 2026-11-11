export type SrtCue = {
  id: number;
  startTime: string;
  endTime: string;
  startMs: number;
  endMs: number;
  text: string;
};

/**
 * Converts standard SRT timestamp "HH:MM:SS,mmm" or "HH:MM:SS.mmm" to milliseconds.
 */
export function timeStringToMs(timeStr: string): number {
  if (!timeStr) return 0;
  const normalized = timeStr.trim().replace(".", ",");
  const [timePart, msPart = "0"] = normalized.split(",");
  const [hStr = "0", mStr = "0", sStr = "0"] = (timePart ?? "").split(":");

  const hours = parseInt(hStr, 10) || 0;
  const minutes = parseInt(mStr, 10) || 0;
  const seconds = parseInt(sStr, 10) || 0;
  const ms = parseInt(msPart.padEnd(3, "0").slice(0, 3), 10) || 0;

  return hours * 3600000 + minutes * 60000 + seconds * 1000 + ms;
}

/**
 * Converts milliseconds to standard SRT timestamp format "HH:MM:SS,mmm".
 */
export function msToTimeString(totalMs: number): string {
  const safeMs = Math.max(0, Math.round(totalMs));
  const ms = safeMs % 1000;
  const totalSeconds = Math.floor(safeMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const hStr = String(hours).padStart(2, "0");
  const mStr = String(minutes).padStart(2, "0");
  const sStr = String(seconds).padStart(2, "0");
  const msStr = String(ms).padStart(3, "0");

  return `${hStr}:${mStr}:${sStr},${msStr}`;
}

/**
 * Parses raw SRT string into a typed array of SrtCue objects.
 */
export function parseSrt(raw: string): SrtCue[] {
  if (!raw || !raw.trim()) return [];

  const cleanRaw = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const blocks = cleanRaw.split(/\n\s*\n+/);
  const cues: SrtCue[] = [];

  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx]?.trim();
    if (!block) continue;

    const lines = block.split("\n").map((l) => l.trimEnd());
    if (lines.length < 2) continue;

    let id = cues.length + 1;
    let timeLineIndex = 0;

    // First line may be the numeric ID or directly the timestamp line
    if (/^\d+$/.test(lines[0] ?? "") && lines.length >= 2) {
      id = parseInt(lines[0] ?? "1", 10) || cues.length + 1;
      timeLineIndex = 1;
    }

    const timeLine = lines[timeLineIndex] ?? "";
    const timeMatch = timeLine.match(
      /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/
    );

    if (!timeMatch || !timeMatch[1] || !timeMatch[2]) continue;

    const startMs = timeStringToMs(timeMatch[1]);
    const endMs = timeStringToMs(timeMatch[2]);
    const textLines = lines.slice(timeLineIndex + 1);
    const text = textLines.join("\n").trim();

    cues.push({
      id,
      startTime: msToTimeString(startMs),
      endTime: msToTimeString(endMs),
      startMs,
      endMs,
      text,
    });
  }

  return cues;
}

/**
 * Reconstructs standard SRT format text from an array of SrtCues.
 */
export function stringifySrt(cues: SrtCue[]): string {
  if (!cues.length) return "";

  return cues
    .map((cue, index) => {
      const cueId = index + 1;
      return `${cueId}\n${cue.startTime} --> ${cue.endTime}\n${cue.text}`;
    })
    .join("\n\n")
    .concat("\n");
}

/**
 * Shifts all cues by a given offset in milliseconds.
 * Ensures timestamps do not go negative.
 */
export function shiftCues(cues: SrtCue[], offsetMs: number): SrtCue[] {
  return cues.map((cue) => {
    const newStartMs = Math.max(0, cue.startMs + offsetMs);
    const duration = Math.max(0, cue.endMs - cue.startMs);
    const newEndMs = newStartMs + duration;

    return {
      ...cue,
      startMs: newStartMs,
      endMs: newEndMs,
      startTime: msToTimeString(newStartMs),
      endTime: msToTimeString(newEndMs),
    };
  });
}

/**
 * Finds and replaces text across all cues, returning updated cues and total count of replacements.
 */
export function replaceTextInCues(
  cues: SrtCue[],
  findText: string,
  replaceText: string,
  matchCase: boolean = false
): { cues: SrtCue[]; count: number } {
  if (!findText) return { cues, count: 0 };

  let count = 0;
  const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, matchCase ? "g" : "gi");

  const updatedCues = cues.map((cue) => {
    const matches = cue.text.match(regex);
    if (matches) {
      count += matches.length;
      return {
        ...cue,
        text: cue.text.replace(regex, replaceText),
      };
    }
    return cue;
  });

  return { cues: updatedCues, count };
}
