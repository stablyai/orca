/** The newest current/recent activity; equal clocks retain the execution host's order. */
export function newestBotActivity<T>(rows: readonly T[], updatedAt: (row: T) => number): T | null {
  return rows.reduce<T | null>(
    (best, row) => (!best || updatedAt(row) > updatedAt(best) ? row : best),
    null
  )
}
