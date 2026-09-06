// Why anchored to the word: no agent currently reports context usage through
// the tab title, and a bare `\d+%` matched any percentage in a task name —
// "contrato 21%" showed up as 21% of context, red badge included.
const CONTEXT_PERCENT_RE = /\bcontext\b[^\d%]{0,16}(\d{1,3})\s*%|\b(\d{1,3})\s*%\s*context\b/i

/** The context-usage percentage a tab title spells out, when it spells one out. */
export function extractContextPercent(title: string): number | undefined {
  const match = CONTEXT_PERCENT_RE.exec(title)
  const raw = match?.[1] ?? match?.[2]
  if (raw === undefined) {
    return undefined
  }
  const val = Number.parseInt(raw, 10)
  return Number.isFinite(val) && val >= 0 && val <= 100 ? val : undefined
}
