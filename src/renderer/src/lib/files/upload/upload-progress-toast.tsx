import { X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  bytesOfTotalText,
  createTimeLeftEstimate,
  throttleProgressRender,
  transferPercent,
  TransferStatusLine,
  TransferTimeLeft
} from '../transfer/transfer-progress'

let nextUploadToastId = 0

export type UploadRow = {
  sourcePath: string
  name: string
  byteLength: number
  sent: number
  status: 'waiting' | 'uploading' | 'uploaded' | 'failed' | 'cancelled'
}

/** Method names match the import's transfer, so the caller passes this handle straight through. */
export type UploadProgressToast = {
  signal: AbortSignal
  onStart: (sources: { sourcePath: string; name: string; byteLength: number }[]) => void
  sourceSignal: (index: number) => AbortSignal
  onProgress: (index: number, sentBytes: number) => void
  onDone: (index: number, outcome: 'uploaded' | 'failed') => void
  close: () => void
}

/** One loading toast per drop, updated in place: a row per file when several upload, each with its own cancel. */
export function showUploadProgressToast(title: string): UploadProgressToast {
  const id = `runtime-file-upload:${nextUploadToastId++}`
  const controller = new AbortController()
  const sourceControllers: AbortController[] = []
  const estimateTimeLeft = createTimeLeftEstimate()
  let rows: UploadRow[] = []
  let closed = false

  // Created on first use by either side, so an X clicked while a file waits still reaches its upload.
  const sourceController = (index: number): AbortController =>
    (sourceControllers[index] ??= new AbortController())
  const isPending = (row: UploadRow | undefined): row is UploadRow =>
    row?.status === 'waiting' || row?.status === 'uploading'
  const updateRow = (index: number, patch: Partial<UploadRow>): void => {
    rows = rows.map((row, i) => (i === index ? { ...row, ...patch } : row))
  }
  const close = (): void => {
    closed = true
    progressRender.cancel()
    toast.dismiss(id)
  }
  const cancelAll = (): void => {
    // Sonner keeps Cancel clickable while the toast animates out; once closed, the paste may already be running.
    if (closed) {
      return
    }
    controller.abort()
    close()
  }
  const cancelFile = (index: number): void => {
    // onDone settles a row before any later click, so a stale X never cancels a committed file.
    if (closed || !isPending(rows[index])) {
      return
    }
    updateRow(index, { status: 'cancelled' })
    sourceController(index).abort()
    progressRender.flush()
  }
  const render = (): void => {
    // A late progress event must not reopen a toast that Cancel or completion closed.
    if (closed) {
      return
    }
    const remainingMs =
      rows.length > 0
        ? estimateTimeLeft(
            rows.reduce((sum, row) => sum + row.sent, 0),
            rows.reduce(
              (sum, row) => (isPending(row) ? sum + Math.max(0, row.byteLength - row.sent) : sum),
              0
            ),
            Date.now()
          )
        : null
    showUploadProgressView(id, title, rows, remainingMs, {
      onCancelFile: cancelFile,
      onCancelAll: cancelAll,
      onDismiss: () => {
        closed = true
        progressRender.cancel()
      }
    })
  }
  const progressRender = throttleProgressRender(render)

  progressRender.flush()
  return {
    signal: controller.signal,
    onStart: (sources) => {
      rows = sources.map((source) => ({ ...source, sent: 0, status: 'waiting' }))
      progressRender.flush()
    },
    sourceSignal: (index) => sourceController(index).signal,
    onProgress: (index, sentBytes) => {
      const row = rows[index]
      if (!isPending(row)) {
        return
      }
      updateRow(index, { sent: sentBytes, status: 'uploading' })
      if (row.status === 'waiting') {
        progressRender.flush()
      } else {
        progressRender.schedule()
      }
    },
    onDone: (index, outcome) => {
      if (!isPending(rows[index])) {
        return
      }
      updateRow(index, { status: outcome })
      progressRender.flush()
    },
    close
  }
}

/** Raises or updates the loading toast for one drop's rows; empty rows while the drop is still staging. */
export function showUploadProgressView(
  id: string,
  title: string,
  rows: UploadRow[],
  remainingMs: number | null,
  actions: { onCancelFile: (index: number) => void; onCancelAll: () => void; onDismiss: () => void }
): void {
  toast.loading(title, {
    id,
    description:
      rows.length > 0 ? (
        <UploadProgressDetail
          rows={rows}
          remainingMs={remainingMs}
          onCancelFile={actions.onCancelFile}
        />
      ) : undefined,
    cancel: {
      label:
        rows.length > 1
          ? translate('files.uploadProgress.cancelAll', 'Cancel all')
          : translate('common.cancel', 'Cancel'),
      onClick: actions.onCancelAll
    },
    duration: Number.POSITIVE_INFINITY,
    onDismiss: actions.onDismiss
  })
}

function rowPercent(row: UploadRow): number {
  if (row.status === 'uploaded') {
    return 100
  }
  // A stopped file's bar empties; its label says why.
  if (row.status === 'cancelled' || row.status === 'failed') {
    return 0
  }
  return transferPercent(row.sent, row.byteLength)
}

function UploadProgressDetail({
  rows,
  remainingMs,
  onCancelFile
}: {
  rows: UploadRow[]
  remainingMs: number | null
  onCancelFile: (index: number) => void
}): React.JSX.Element {
  const t = useTranslate()
  const timeLeft = <TransferTimeLeft remainingMs={remainingMs} />
  if (rows.length === 1) {
    const percent = rowPercent(rows[0])
    return (
      <div className="flex w-full flex-col gap-1.5">
        <RowStatusLine t={t} row={rows[0]} percent={percent} />
        <Progress value={percent} aria-label={rows[0].name} className="h-1.5" />
        {timeLeft}
      </div>
    )
  }
  return (
    <div className="flex w-full flex-col gap-2.5">
      <ul className="scrollbar-sleek flex max-h-56 flex-col gap-2.5 overflow-y-auto">
        {rows.map((row, index) => {
          const percent = rowPercent(row)
          const pending = row.status === 'waiting' || row.status === 'uploading'
          return (
            <li key={row.sourcePath} className="flex flex-col gap-1">
              {/* min-h holds the row's height when its cancel button goes away. */}
              <div className="flex min-h-6 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-popover-foreground">{row.name}</span>
                {pending ? (
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label={t('files.uploadProgress.cancelFile', 'Cancel {{name}}', {
                      name: row.name
                    })}
                    onClick={() => onCancelFile(index)}
                  >
                    <X className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              <RowStatusLine t={t} row={row} percent={percent} inList />
              <Progress value={percent} aria-label={row.name} className="h-1" />
            </li>
          )
        })}
      </ul>
      {timeLeft}
    </div>
  )
}

function RowStatusLine({
  t,
  row,
  percent,
  inList = false
}: {
  t: Translate
  row: UploadRow
  percent: number
  /** Only a file in a list waits behind others; a lone file shows its bytes from the start. */
  inList?: boolean
}): React.JSX.Element {
  const label =
    row.status === 'waiting' && inList
      ? t('files.uploadProgress.waiting', 'Waiting')
      : row.status === 'cancelled'
        ? t('files.uploadProgress.cancelled', 'Cancelled')
        : row.status === 'failed'
          ? t('files.uploadProgress.failed', 'Failed')
          : bytesOfTotalText(t, row.sent, row.byteLength)
  const showPercent =
    row.status === 'uploading' || row.status === 'uploaded' || (row.status === 'waiting' && !inList)
  return (
    <TransferStatusLine label={label} percent={showPercent ? percent : null} compact={inList} />
  )
}
