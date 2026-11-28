import { cn } from '@/lib/class-names'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatBytes } from '../../../../../shared/text/format-bytes'
import { formatResetDuration } from '../../../../../shared/agent-usage/rate-limits/rate-limit-reset-format'

const PROGRESS_RENDER_INTERVAL_MS = 100
// Hold the estimate until a few seconds of transfer give a rate worth trusting.
const TIME_LEFT_WARMUP_MS = 3_000
// Chunk acknowledgements arrive in bursts; smooth over ~5 s so the estimate doesn't jump.
const RATE_SMOOTHING_MS = 5_000

// Intl formatter caches key on option identity, so these must be module constants.
const PERCENT_FORMAT: Intl.NumberFormatOptions = { style: 'percent' }
const DURATION_UNIT_FORMATS: Record<'minute' | 'hour' | 'day', Intl.NumberFormatOptions> = {
  minute: { style: 'unit', unit: 'minute', unitDisplay: 'short' },
  hour: { style: 'unit', unit: 'hour', unitDisplay: 'short' },
  day: { style: 'unit', unit: 'day', unitDisplay: 'short' }
}

/** Renders at most every 100 ms; a skipped update still renders once the interval ends, so a slow
 *  next chunk never leaves stale bytes on screen. */
export function throttleProgressRender(render: () => void): {
  /** Render now, e.g. when a status changes. */
  flush: () => void
  /** Render now or at the end of the interval, for byte counts. */
  schedule: () => void
  cancel: () => void
} {
  let renderedAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const flush = (): void => {
    cancel()
    renderedAt = Date.now()
    render()
  }
  return {
    flush,
    schedule: () => {
      if (timer !== null) {
        return
      }
      const wait = renderedAt + PROGRESS_RENDER_INTERVAL_MS - Date.now()
      if (wait <= 0) {
        flush()
      } else {
        timer = setTimeout(flush, wait)
      }
    },
    cancel
  }
}

/** Milliseconds left at the smoothed rate; null until a steady rate is known. Transferred bytes include
 *  cancelled and failed files' partial bytes so the rate never dips when one stops. */
export function createTimeLeftEstimate(): (
  transferredBytes: number,
  remainingBytes: number,
  now: number
) => number | null {
  let startedAt: number | null = null
  let startTransferred = 0
  let lastAt = 0
  let lastTransferred = 0
  let bytesPerMs: number | null = null
  let remainingMs: number | null = null
  return (transferred, remaining, now) => {
    if (startedAt === null) {
      startedAt = lastAt = now
      startTransferred = lastTransferred = transferred
      return null
    }
    const elapsed = now - lastAt
    if (elapsed <= 0 || now - startedAt < TIME_LEFT_WARMUP_MS) {
      return remainingMs
    }
    const recent = (transferred - lastTransferred) / elapsed
    lastAt = now
    lastTransferred = transferred
    // Seed with the warm-up average, then follow the recent rate.
    bytesPerMs =
      bytesPerMs === null
        ? (transferred - startTransferred) / (now - startedAt)
        : bytesPerMs + (1 - Math.exp(-elapsed / RATE_SMOOTHING_MS)) * (recent - bytesPerMs)
    remainingMs = bytesPerMs > 0 ? remaining / bytesPerMs : null
    return remainingMs
  }
}

// Floor so a bar never says 100% while its bytes are still in flight.
export function transferPercent(doneBytes: number, totalBytes: number): number {
  return totalBytes > 0 ? Math.floor((Math.min(doneBytes, totalBytes) / totalBytes) * 100) : 0
}

export function bytesOfTotalText(t: Translate, doneBytes: number, totalBytes: number): string {
  return t('files.transferProgress.bytesOfTotal', '{{done}} of {{total}}', {
    done: formatBytes(Math.min(doneBytes, totalBytes)),
    total: formatBytes(totalBytes)
  })
}

/** The "274 MB of 600 MB" line, with the percent at its end when there is one. */
export function TransferStatusLine({
  label,
  percent,
  compact = false
}: {
  label: string
  percent: number | null
  compact?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn('flex items-baseline justify-between gap-3 tabular-nums', compact && 'text-xs')}
    >
      <span className="min-w-0 truncate">{label}</span>
      {percent === null ? null : (
        <span className="shrink-0 text-popover-foreground">
          {uiNumberFormat(PERCENT_FORMAT).format(percent / 100)}
        </span>
      )}
    </div>
  )
}

/** Kept in the layout during the warm-up, so the toast doesn't grow when the estimate appears. */
export function TransferTimeLeft({
  remainingMs
}: {
  remainingMs: number | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className={cn('text-xs', remainingMs === null && 'invisible')}>
      {remainingMs === null ? '\u00a0' : timeLeftText(t, remainingMs)}
    </span>
  )
}

function timeLeftText(t: Translate, remainingMs: number): string {
  if (remainingMs < 60_000) {
    return t('files.transferProgress.lessThanMinuteLeft', 'Less than a minute remaining')
  }
  // Round up so the last minute reads "Less than a minute", never "About 0 min".
  const duration = formatResetDuration(Math.ceil(remainingMs / 60_000) * 60_000, (value, unit) =>
    uiNumberFormat(DURATION_UNIT_FORMATS[unit]).format(value)
  )
  return t('files.transferProgress.timeLeft', 'About {{duration}} remaining', { duration })
}
