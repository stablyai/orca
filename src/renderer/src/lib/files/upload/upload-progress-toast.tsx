import { Clock, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
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

let nextUploadToastId = 0

export type UploadProgressToast = {
  signal: AbortSignal
  setTotal: (totalBytes: number) => void
  update: (sentBytes: number) => void
  close: () => void
}

/** One toast per upload, updated in place: bytes, percent, time left, and a Cancel that aborts it. */
export function showUploadProgressToast(title: string): UploadProgressToast {
  const id = `runtime-file-upload:${nextUploadToastId++}`
  const controller = new AbortController()
  const estimateTimeLeft = createTimeLeftEstimate()
  let total = 0
  let sent = 0
  let renderedAt = 0
  let closed = false

  // Hiding only removes the toast; the upload keeps going and still pastes when done.
  const close = (): void => {
    closed = true
    toast.dismiss(id)
  }
  const cancel = (): void => {
    controller.abort()
    close()
  }
  const render = (): void => {
    // A late progress event must not reopen a toast that Cancel, hiding or completion closed.
    if (closed) {
      return
    }
    renderedAt = Date.now()
    const view = { sent, total, remainingMs: estimateTimeLeft(sent, total, renderedAt) }
    toast.custom(
      () => <UploadProgressCard title={title} {...view} onHide={close} onCancel={cancel} />,
      {
        id,
        duration: Number.POSITIVE_INFINITY,
        closeButton: false,
        unstyled: true,
        onDismiss: () => {
          closed = true
        }
      }
    )
  }

  render()
  return {
    signal: controller.signal,
    setTotal: (totalBytes) => {
      total = totalBytes
      render()
    },
    update: (sentBytes) => {
      sent = sentBytes
      if (Date.now() - renderedAt >= PROGRESS_RENDER_INTERVAL_MS) {
        render()
      }
    },
    close
  }
}

/** Milliseconds left at the smoothed upload rate; null while the total or a steady rate is unknown. */
function createTimeLeftEstimate(): (sent: number, total: number, now: number) => number | null {
  let startedAt: number | null = null
  let startSent = 0
  let lastAt = 0
  let lastSent = 0
  let bytesPerMs: number | null = null
  let remainingMs: number | null = null
  return (sent, total, now) => {
    if (total <= 0) {
      return null
    }
    if (startedAt === null) {
      startedAt = lastAt = now
      startSent = lastSent = sent
      return null
    }
    const elapsed = now - lastAt
    if (elapsed <= 0 || now - startedAt < TIME_LEFT_WARMUP_MS) {
      return remainingMs
    }
    const recent = (sent - lastSent) / elapsed
    lastAt = now
    lastSent = sent
    // Seed with the warm-up average, then follow the recent rate.
    bytesPerMs =
      bytesPerMs === null
        ? (sent - startSent) / (now - startedAt)
        : bytesPerMs + (1 - Math.exp(-elapsed / RATE_SMOOTHING_MS)) * (recent - bytesPerMs)
    remainingMs = bytesPerMs > 0 ? Math.max(0, total - sent) / bytesPerMs : null
    return remainingMs
  }
}

function timeLeftText(t: Translate, remainingMs: number): string {
  if (remainingMs < 60_000) {
    return t('files.uploadProgress.lessThanMinuteLeft', 'Less than a minute remaining')
  }
  // Round up so the last minute reads "Less than a minute", never "About 0 min".
  const duration = formatResetDuration(Math.ceil(remainingMs / 60_000) * 60_000, (value, unit) =>
    uiNumberFormat(DURATION_UNIT_FORMATS[unit]).format(value)
  )
  return t('files.uploadProgress.timeLeft', 'About {{duration}} remaining', { duration })
}

export function UploadProgressCard({
  title,
  sent,
  total,
  remainingMs,
  onHide,
  onCancel
}: {
  title: string
  sent: number
  total: number
  remainingMs: number | null
  onHide: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const shown = Math.min(sent, total)
  // Floor so the toast never says 100% while bytes are still in flight.
  const percent = total > 0 ? Math.floor((shown / total) * 100) : 0
  return (
    <Card size="notice" role="group" aria-label={title} className="w-full">
      <div className="flex flex-col gap-3 p-3.5">
        <div className="flex items-center gap-3">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
            aria-hidden
          >
            <Upload className="size-4" />
          </span>
          <p className="min-w-0 flex-1 text-sm leading-snug font-semibold">{title}</p>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            className="self-start"
            aria-label={t('files.uploadProgress.hide', 'Hide')}
            onClick={onHide}
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          {/* Kept in the layout before the total is known, so the toast doesn't grow mid-upload. */}
          <div
            className={cn(
              'flex items-baseline justify-between gap-3 text-xs tabular-nums',
              total === 0 && 'invisible'
            )}
          >
            <span className="min-w-0 truncate text-muted-foreground">
              {t('files.uploadProgress.sentOfTotal', '{{sent}} of {{total}} uploaded', {
                sent: formatBytes(shown),
                total: formatBytes(total)
              })}
            </span>
            <span className="shrink-0 font-semibold">
              {uiNumberFormat(PERCENT_FORMAT).format(percent / 100)}
            </span>
          </div>
          <Progress value={percent} aria-label={title} className="h-1.5" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {remainingMs === null ? null : (
              <>
                <Clock className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{timeLeftText(t, remainingMs)}</span>
              </>
            )}
          </span>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
        </div>
      </div>
    </Card>
  )
}
