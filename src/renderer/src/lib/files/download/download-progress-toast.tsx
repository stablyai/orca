import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Progress } from '@/components/ui/progress'
import { formatBytes } from '../../../../../shared/text/format-bytes'

const PROGRESS_RENDER_INTERVAL_MS = 100

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
  let total: number | null = null
  let received = 0
  let renderedAt = 0
  let closed = false

  const render = (): void => {
    // Why: a late size or chunk must not reopen a toast that Cancel or completion closed.
    if (closed || controller.signal.aborted) {
      return
    }
    renderedAt = Date.now()
    toast.loading(
      translate('files.download.progress.title', 'Downloading {{name}}…', { name: fileName }),
      {
        id,
        description: <DownloadProgressDetail received={received} total={total} />,
        action: {
          label: translate('files.download.progress.cancel', 'Cancel'),
          onClick: () => controller.abort()
        }
      }
    )
  }

  render()
  void totalBytes.then((bytes) => {
    total = bytes
    render()
  })

  return {
    signal: controller.signal,
    update: (receivedBytes) => {
      received = receivedBytes
      if (Date.now() - renderedAt >= PROGRESS_RENDER_INTERVAL_MS) {
        render()
      }
    },
    close: () => {
      closed = true
      toast.dismiss(id)
    }
  }
}

function DownloadProgressDetail({
  received,
  total
}: {
  received: number
  total: number | null
}): React.JSX.Element {
  const percent = total ? Math.min(100, Math.round((received / total) * 100)) : null
  return (
    <div className="flex w-full flex-col gap-1.5">
      <span className="tabular-nums">
        {total === null
          ? formatBytes(received)
          : `${formatBytes(received)} / ${formatBytes(total)}`}
      </span>
      {percent === null ? null : <Progress value={percent} className="h-1.5" />}
    </div>
  )
}
