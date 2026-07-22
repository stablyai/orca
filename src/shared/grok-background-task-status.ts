const TASK_COUNT_RE = /\btasks\s+(\d+)\b/gi
const WATCHING_COUNT_RE = /\bwatching\s*·\s*(\d+)\s+commands?\b/gi

function readLatestCount(text: string, pattern: RegExp): number | null {
  let count: number | null = null
  for (const match of text.matchAll(pattern)) {
    count = Number(match[1])
  }
  return count
}

export function hasActiveGrokBackgroundTasks(
  terminalText: string,
  isGrokSession: boolean
): boolean {
  if (!isGrokSession) {
    return false
  }
  const taskCount = readLatestCount(terminalText, TASK_COUNT_RE)
  const watchingCount = readLatestCount(terminalText, WATCHING_COUNT_RE)
  return taskCount !== null && taskCount > 0 && watchingCount !== null && watchingCount > 0
}
