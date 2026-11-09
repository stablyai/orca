import { getIntlLocale } from '@/i18n/i18n'
import { useEffect, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'

/** Ticks once a second while `running`; paused while the window is hidden to avoid unseen rerenders. */
export function useWorktreeCreationClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) {
      return
    }
    return installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 1000 })
  }, [running])
  return now
}

type DurationFormatter = { format: (duration: Record<string, number>) => string }
type DurationFormatConstructor = new (
  locale: string,
  options: { style: 'narrow'; secondsDisplay: 'always' }
) => DurationFormatter

const durationFormatters = new Map<string, DurationFormatter | null>()

// Intl.DurationFormat localizes units ("1m 5s", "1 Min., 5 Sek."); older runtimes keep the English form.
function durationFormatter(locale: string): DurationFormatter | null {
  if (!durationFormatters.has(locale)) {
    const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatConstructor })
      .DurationFormat
    durationFormatters.set(
      locale,
      DurationFormat
        ? new DurationFormat(locale, { style: 'narrow', secondsDisplay: 'always' })
        : null
    )
  }
  return durationFormatters.get(locale) ?? null
}

export function formatElapsedTime(elapsedMs: number, locale: string = getIntlLocale()): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const formatter = durationFormatter(locale)
  if (formatter) {
    return formatter.format({ hours, minutes, seconds })
  }
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes === 0) {
    return `${seconds}s`
  }
  return `${totalMinutes}m ${seconds.toString().padStart(2, '0')}s`
}
