import { toast } from 'sonner'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { formatBytes } from '../../../../../shared/text/format-bytes'
import {
  bytesOfTotalText,
  createTimeLeftEstimate,
  throttleProgressRender,
  transferPercent,
  TransferStatusLine,
  TransferTimeLeft
} from '../transfer/transfer-progress'

let nextDownloadToastId = 0

export type DownloadProgressToast = {
  signal: AbortSignal
  update: (receivedBytes: number) => void
  close: () => void
}

/** One loading toast per download, updated in place, whose Cancel aborts the transfer. */
export function showDownloadProgressToast(
  fileName: string,
  totalBytes: Promise<number | null>
): DownloadProgressToast {
  const id = `runtime-file-download:${nextDownloadToastId++}`
  const controller = new AbortController()
  const estimateTimeLeft = createTimeLeftEstimate()
  let total: number | null = null
  let received = 0
  let closed = false

  const close = (): void => {
    closed = true
    progressRender.cancel()
    toast.dismiss(id)
  }
  const render = (): void => {
    // A late size or chunk must not reopen a toast that Cancel or completion closed.
    if (closed) {
      return
    }
    const remainingMs =
      total === null ? null : estimateTimeLeft(received, Math.max(0, total - received), Date.now())
    showDownloadProgressView(id, fileName, received, total, remainingMs, {
      onCancel: () => {
        // Sonner keeps Cancel clickable while the toast animates out; once closed, the file may be saving.
        if (closed) {
          return
        }
        controller.abort()
        close()
      },
      onDismiss: () => {
        closed = true
        progressRender.cancel()
      }
    })
  }
  const progressRender = throttleProgressRender(render)

  progressRender.flush()
  void totalBytes.then((bytes) => {
    total = bytes
    progressRender.flush()
  })
  return {
    signal: controller.signal,
    update: (receivedBytes) => {
      received = receivedBytes
      progressRender.schedule()
    },
    close
  }
}

/** Raises or updates one download's loading toast; a null total (the host couldn't say) shows bytes only. */
export function showDownloadProgressView(
  id: string,
  fileName: string,
  received: number,
  total: number | null,
  remainingMs: number | null,
  actions: { onCancel: () => void; onDismiss: () => void }
): void {
  toast.loading(
    translate('files.downloadProgress.title', 'Downloading {{name}}…', { name: fileName }),
    {
      id,
      description: (
        <DownloadProgressDetail
          fileName={fileName}
          received={received}
          total={total}
          remainingMs={remainingMs}
        />
      ),
      cancel: { label: translate('common.cancel', 'Cancel'), onClick: actions.onCancel },
      duration: Number.POSITIVE_INFINITY,
      onDismiss: actions.onDismiss
    }
  )
}

function DownloadProgressDetail({
  fileName,
  received,
  total,
  remainingMs
}: {
  fileName: string
  received: number
  total: number | null
  remainingMs: number | null
}): React.JSX.Element {
  const t = useTranslate()
  if (total === null) {
    return (
      <div className="flex w-full flex-col gap-1.5">
        <TransferStatusLine label={formatBytes(received)} percent={null} />
        {/* Without a total the bar can only show that bytes are moving. */}
        <div
          role="progressbar"
          aria-label={fileName}
          className="h-1.5 w-full overflow-hidden rounded-full bg-primary/20"
        >
          <div className="h-full w-2/5 animate-[skill-update-slide_1.35s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
        </div>
      </div>
    )
  }
  const percent = transferPercent(received, total)
  return (
    <div className="flex w-full flex-col gap-1.5">
      <TransferStatusLine label={bytesOfTotalText(t, received, total)} percent={percent} />
      <Progress value={percent} aria-label={fileName} className="h-1.5" />
      <TransferTimeLeft remainingMs={remainingMs} />
    </div>
  )
}
