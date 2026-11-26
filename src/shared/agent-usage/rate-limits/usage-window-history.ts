import * as z from 'zod'

/** One reading of a window's used percent, stamped with the provider's own reading time. */
export type UsageHistorySample = { at: number; usedPercent: number }

/** The current instance of one rate-limit window: a reset starts a new series. */
export type UsageWindowHistory = {
  resetsAt: number | null
  windowMinutes: number
  samples: UsageHistorySample[]
}

/** Keyed by `${providerKey}:${windowId}`, e.g. `claude:weekly` or `codex:session`. */
export type UsageHistoryByWindow = Record<string, UsageWindowHistory>

const UsageWindowHistorySchema = z.object({
  resetsAt: z.number().finite().nullable(),
  windowMinutes: z.number().finite().positive(),
  samples: z.array(z.object({ at: z.number().finite(), usedPercent: z.number().finite() }))
})

/** Persisted or streamed history; a malformed series is dropped rather than failing the rest. */
export function parseUsageHistory(raw: unknown): UsageHistoryByWindow {
  const record = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!record.success) {
    return {}
  }
  const history: UsageHistoryByWindow = {}
  for (const [key, value] of Object.entries(record.data)) {
    const series = UsageWindowHistorySchema.safeParse(value)
    if (series.success) {
      history[key] = series.data
    }
  }
  return history
}

type HistoryWindow = { usedPercent: number; windowMinutes: number; resetsAt: number | null }

export type UsageWindowKind = 'session' | 'weekly' | 'fableWeekly' | 'monthly' | 'bucket'

export type UsageWindowSlot<W> = {
  id: string
  kind: UsageWindowKind
  /** A bucket's own name; null for the standard windows. */
  name: string | null
  window: W
}

type WindowedLimits<W> = {
  session?: W | null
  weekly?: W | null
  fableWeekly?: W | null
  monthly?: W | null
  buckets?: readonly (W & { name: string })[]
}

/** A provider's windows with stable ids; the desktop's history keys and mobile's rows share them. */
export function listUsageWindowSlots<W>(limits: WindowedLimits<W>): UsageWindowSlot<W>[] {
  const standard = (['session', 'weekly', 'fableWeekly', 'monthly'] as const).flatMap((kind) => {
    const window = limits[kind]
    return window ? [{ id: kind, kind, name: null, window }] : []
  })
  const buckets = (limits.buckets ?? []).map((bucket, index) => ({
    id: `bucket:${index}:${bucket.name}`,
    kind: 'bucket' as const,
    name: bucket.name,
    window: bucket
  }))
  return [...standard, ...buckets]
}

export function usageHistoryKey(provider: string, windowId: string): string {
  return `${provider}:${windowId}`
}

// Enough points for a smooth weekly line; one sample per 15-minute poll fills a 5-hour window's 20.
export const USAGE_HISTORY_MAX_SAMPLES = 168

function sameWindowInstance(previous: UsageWindowHistory, window: HistoryWindow): boolean {
  if (previous.windowMinutes !== window.windowMinutes) {
    return false
  }
  if (previous.resetsAt === null || window.resetsAt === null) {
    return previous.resetsAt === window.resetsAt
  }
  // Providers round or recompute the reset between polls; only a jump of a slice of the window is a new one.
  const toleranceMs = Math.min(60 * 60_000, (window.windowMinutes * 60_000) / 20)
  return Math.abs(previous.resetsAt - window.resetsAt) <= toleranceMs
}

/** The series after one reading: a reset starts afresh, and points thin to one per window slice. */
export function recordUsageWindowSample(
  previous: UsageWindowHistory | undefined,
  window: HistoryWindow,
  at: number
): UsageWindowHistory {
  const windowMs = window.windowMinutes * 60_000
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent))
  const continuing = previous && sameWindowInstance(previous, window)
  const windowStart = window.resetsAt === null ? at - windowMs : window.resetsAt - windowMs
  let samples = continuing ? previous.samples.filter((sample) => sample.at >= windowStart) : []
  const last = samples.at(-1)
  if (last && at <= last.at) {
    return { resetsAt: window.resetsAt, windowMinutes: window.windowMinutes, samples }
  }
  const sliceMs = windowMs / USAGE_HISTORY_MAX_SAMPLES
  const beforeLast = samples.at(-2)
  // Inside one slice keep its first and latest readings, so the line still steps where usage jumped.
  samples =
    last && beforeLast && at - beforeLast.at < sliceMs
      ? [...samples.slice(0, -1), { at, usedPercent }]
      : [...samples, { at, usedPercent }]
  if (samples.length > USAGE_HISTORY_MAX_SAMPLES) {
    samples = samples.slice(samples.length - USAGE_HISTORY_MAX_SAMPLES)
  }
  return { resetsAt: window.resetsAt, windowMinutes: window.windowMinutes, samples }
}

/** Drops series whose window has ended, so the store only ever holds current windows. */
export function pruneEndedUsageHistory(
  history: UsageHistoryByWindow,
  now: number
): UsageHistoryByWindow {
  const kept: UsageHistoryByWindow = {}
  for (const [key, series] of Object.entries(history)) {
    const last = series.samples.at(-1)
    const ended =
      series.resetsAt === null
        ? !last || now - last.at > series.windowMinutes * 60_000
        : series.resetsAt <= now
    if (!ended) {
      kept[key] = series
    }
  }
  return kept
}
