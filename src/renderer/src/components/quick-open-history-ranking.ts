import {
  getPreparedQuickOpenFiles,
  rankQuickOpenFiles,
  QUICK_OPEN_RESULT_LIMIT
} from './quick-open-search'

/** Keeps a host-ranked page in host order; recent files on the page still lead, newest first. */
export function orderHostRankedQuickOpenFiles(
  files: readonly string[],
  history: readonly string[]
): { path: string; score: number }[] {
  const available = new Set(files)
  const recent = history.filter((path) => available.has(path))
  const recentPaths = new Set(recent)
  return [...recent, ...files.filter((path) => !recentPaths.has(path))]
    .slice(0, QUICK_OPEN_RESULT_LIMIT)
    .map((path, index) => ({ path, score: index }))
}

export function rankQuickOpenFilesWithHistory(
  query: string,
  files: readonly string[],
  history: readonly string[]
): { path: string; score: number }[] {
  const available = new Set(files)
  const eligibleHistory = history.filter((path) => available.has(path))
  const recent = rankQuickOpenFiles(
    query,
    getPreparedQuickOpenFiles(eligibleHistory),
    eligibleHistory.length
  )
  const recency = new Map(eligibleHistory.map((path, index) => [path, index]))
  recent.sort((a, b) => (recency.get(a.path) ?? 0) - (recency.get(b.path) ?? 0))
  const recentPaths = new Set(recent.map((item) => item.path))
  return [
    ...recent,
    ...rankQuickOpenFiles(query, getPreparedQuickOpenFiles(files)).filter(
      (item) => !recentPaths.has(item.path)
    )
  ].slice(0, QUICK_OPEN_RESULT_LIMIT)
}
