type QueueRow = {
  id: string;
  tmdb_id: number;
  media_type: string;
  title: string;
  season_number: number | null;
  episode_number: number | null;
  status: string;
};

export function groupQueueSeasons<T extends QueueRow>(rows: T[], unfiltered: boolean) {
  const groups = new Map<string, { key: string; title: string; season: number | null; isTv: boolean; rows: T[] }>();
  for (const row of rows) {
    const isTv = row.media_type === "tv";
    const key = isTv ? `tv:${row.tmdb_id}:${row.season_number ?? 0}` : `job:${row.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, title: isTv ? row.title.replace(/\s+S\d+E\d+\s*$/i, "") : row.title, season: row.season_number, isTv, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].map((group) => {
    const completedCount = group.rows.filter((row) => row.status === "completed").length;
    return {
      ...group,
      rows: group.isTv ? [...group.rows].sort((a, b) => (a.episode_number ?? 0) - (b.episode_number ?? 0)) : group.rows,
      completedCount,
      defaultCollapsed: group.isTv && unfiltered && completedCount === group.rows.length,
    };
  });
}