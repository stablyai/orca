import { getIntlLocale } from '@/i18n/i18n'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { useEffect, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'

/** Ticks once a second while `running`; paused while the window is hidden to avoid unseen rerenders. */
export function useWorktreeCreationClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) {
      return
    }
    // A resumed clock reads the time at once rather than a tick later.
    setNow(Date.now())
    return installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 1000 })
  }, [running])
  return now
}

/**
 * The build's own time: stopped while failed checks wait on the user (and at an error), with the
 * waits left out, and never reading earlier than the last resume, so a stale tick cannot flicker back.
 */
export function buildClockElapsedMs(
  entry: Pick<
    PendingWorktreeCreation,
    'startedAt' | 'status' | 'errorAt' | 'waitingSince' | 'pausedMs' | 'resumedAt'
  >,
  now: number
): number {
  const end =
    entry.waitingSince ??
    (entry.status === 'error' ? entry.errorAt : undefined) ??
    Math.max(now, entry.resumedAt ?? 0)
  return Math.max(0, end - entry.startedAt - (entry.pausedMs ?? 0))
}

type DurationFormatter = { format: (duration: Record<string, number>) => string }
type DurationFormatOptions = {
  style: 'narrow'
  secondsDisplay: 'always'
  minutesDisplay: 'always' | 'auto'
}
type DurationFormatConstructor = new (
  locale: string,
  options: DurationFormatOptions
) => DurationFormatter

const durationFormatters = new Map<string, DurationFormatter | null>()

// Intl.DurationFormat localizes units ("1m 5s", "1 Min., 5 Sek."); runtimes without it get the same
// English shape. Past an hour the minutes always show ("1h 0m 5s"), so a glance never misreads it.
function durationFormatter(locale: string, withHours: boolean): DurationFormatter | null {
  const key = `${locale}|${withHours}`
  if (!durationFormatters.has(key)) {
    const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatConstructor })
      .DurationFormat
    let formatter: DurationFormatter | null = null
    try {
      formatter = DurationFormat
        ? new DurationFormat(locale, {
            style: 'narrow',
            secondsDisplay: 'always',
            minutesDisplay: withHours ? 'always' : 'auto'
          })
        : null
    } catch {
      // An unsupported locale tag falls back to the English shape below.
    }
    durationFormatters.set(key, formatter)
  }
  return durationFormatters.get(key) ?? null
}

export function formatElapsedTime(elapsedMs: number, locale: string = getIntlLocale()): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const formatter = durationFormatter(locale, hours > 0)
  if (formatter) {
    return formatter.format({ hours, minutes, seconds })
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}
