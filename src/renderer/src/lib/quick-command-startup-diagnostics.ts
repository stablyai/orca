/**
 * TEMPORARY diagnostics for STA-4876. Remove before merge.
 *
 * Prints the full life of a queued startup command for one quick-command click, so we can see on
 * a real loaded machine whether a pane remount lands between the pane taking the command and its
 * shell existing — the window in which the command used to be lost for good.
 *
 * Read it in DevTools (Cmd+Opt+I) filtered on `STA-4876`.
 */
export function logQuickCommandStartupDiagnostic(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {}
): void {
  try {
    const detail = Object.entries(fields)
      .map(([key, value]) => `${key}=${value ?? 'none'}`)
      .join(' ')
    // eslint-disable-next-line no-console
    console.log(
      `[STA-4876] ${event}${detail ? ` ${detail}` : ''} t=${Math.round(performance.now())}`
    )
  } catch {
    // Diagnostics must never break a launch.
  }
}
