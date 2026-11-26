import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Progress } from '@/components/ui/progress'
import { formatBytes } from '../../../../../shared/text/format-bytes'

const PROGRESS_RENDER_INTERVAL_MS = 100

let nextUploadToastId = 0

export type UploadProgressToast = {
  signal: AbortSignal
  setTotal: (totalBytes: number) => void
  update: (sentBytes: number) => void
  close: () => void
}

/** One loading toast per upload, updated in place, whose Cancel aborts the transfer. */
export function showUploadProgressToast(title: string): UploadProgressToast {
  const id = `runtime-file-upload:${nextUploadToastId++}`
  const controller = new AbortController()
  let total = 0
  let sent = 0
  let renderedAt = 0
  let closed = false

  const close = (): void => {
    closed = true
    toast.dismiss(id)
  }
  const render = (): void => {
    // A late progress event must not reopen a toast that Cancel or completion closed.
    if (closed) {
      return
    }
    renderedAt = Date.now()
    toast.loading(title, {
      id,
      description: total > 0 ? <UploadProgressDetail sent={sent} total={total} /> : undefined,
      action: {
        label: translate('common.cancel', 'Cancel'),
        onClick: () => {
          controller.abort()
          close()
        }
      }
    })
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

function UploadProgressDetail({ sent, total }: { sent: number; total: number }): React.JSX.Element {
  const shown = Math.min(sent, total)
  return (
    <div className="flex w-full flex-col gap-1.5">
      <span className="tabular-nums">{`${formatBytes(shown)} / ${formatBytes(total)}`}</span>
      <Progress value={Math.round((shown / total) * 100)} className="h-1.5" />
    </div>
  )
}
