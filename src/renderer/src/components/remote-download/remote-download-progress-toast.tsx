import { toast } from 'sonner'
import { Progress } from '@/components/ui/progress'
import { formatByteCount } from '@/components/browser-pane/navigate/browser-notices'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type {
  RuntimeFileDownloadResult,
  RuntimeFileDownloadTransfer
} from '@/runtime/runtime-file-client'
import {
  createRemoteDownloadProgressTracker,
  type RemoteDownloadProgress
} from '../../../../shared/remote-download-progress'

// Why: SSH latency makes small downloads finish fast locally; only slow ones earn a toast.
export const REMOTE_DOWNLOAD_TOAST_DELAY_MS = 200

type RemoteDownloadItem = { name: string; isDirectory: boolean }

export function formatRemoteDownloadDetail(
  progress: RemoteDownloadProgress,
  isDirectory: boolean
): string {
  const transferred = formatByteCount(progress.transferredBytes) ?? ''
  const total = formatByteCount(progress.totalBytes)
  const bytes = total ? `${transferred} / ${total}` : transferred
  if (!isDirectory) {
    return bytes
  }
  const count = progress.completedFiles
  return count === 1
    ? translate('remoteDownload.progress.folderDetail_one', '{{count}} file · {{bytes}}', {
        count,
        bytes
      })
    : translate('remoteDownload.progress.folderDetail_other', '{{count}} files · {{bytes}}', {
        count,
        bytes
      })
}

export function getRemoteDownloadPercent(progress: RemoteDownloadProgress): number | null {
  if (progress.totalBytes === null || progress.totalBytes <= 0) {
    return null
  }
  return Math.min(100, Math.round((progress.transferredBytes / progress.totalBytes) * 100))
}

function RemoteDownloadProgressBody({
  progress,
  isDirectory
}: {
  progress: RemoteDownloadProgress
  isDirectory: boolean
}): React.JSX.Element {
  const percent = getRemoteDownloadPercent(progress)
  return (
    <div className="flex w-full flex-col gap-1.5">
      {percent !== null ? <Progress value={percent} className="h-1.5" /> : null}
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatRemoteDownloadDetail(progress, isDirectory)}
        {percent !== null ? ` · ${percent}%` : null}
      </span>
    </div>
  )
}

function formatRemoteDownloadTitle(item: RemoteDownloadItem): string {
  return item.isDirectory
    ? translate('remoteDownload.progress.folderTitle', "Downloading folder '{{name}}'", {
        name: item.name
      })
    : translate('remoteDownload.progress.fileTitle', "Downloading '{{name}}'", {
        name: item.name
      })
}

/**
 * Shows a live progress toast with a Cancel action while `run` transfers a remote file or folder.
 * A user cancel resolves as `{ canceled: true }` so callers treat it like a dismissed save dialog.
 */
export async function runRemoteDownloadWithProgress(
  item: RemoteDownloadItem,
  run: (transfer: RuntimeFileDownloadTransfer) => Promise<RuntimeFileDownloadResult>
): Promise<RuntimeFileDownloadResult> {
  const downloadId = createBrowserUuid()
  const toastId = `remote-download:${downloadId}`
  const controller = new AbortController()
  let latest: RemoteDownloadProgress | null = null
  let visible = false
  let settled = false
  let reportedCancel = false
  let showTimer: ReturnType<typeof setTimeout> | null = null

  const cancel = (): void => {
    if (controller.signal.aborted) {
      return
    }
    controller.abort(new Error('Download canceled'))
    void window.api.fs.cancelDownload({ downloadId }).catch(() => {})
    toast.loading(translate('remoteDownload.progress.canceling', 'Canceling download…'), {
      id: toastId,
      description: undefined,
      action: undefined
    })
  }

  const paint = (): void => {
    if (!latest || settled || controller.signal.aborted) {
      return
    }
    visible = true
    toast.loading(formatRemoteDownloadTitle(item), {
      id: toastId,
      duration: Infinity,
      description: <RemoteDownloadProgressBody progress={latest} isDirectory={item.isDirectory} />,
      action: {
        label: translate('remoteDownload.progress.cancel', 'Cancel'),
        onClick: (event) => {
          // Why: keep the toast open so it can report "Canceling…" until the transfer stops.
          event.preventDefault()
          cancel()
        }
      }
    })
  }

  const onProgress = (progress: RemoteDownloadProgress): void => {
    latest = progress
    if (visible) {
      paint()
      return
    }
    showTimer ??= setTimeout(paint, REMOTE_DOWNLOAD_TOAST_DELAY_MS)
  }

  const unsubscribe = window.api.fs.onDownloadProgress((progress) => {
    if (progress.downloadId === downloadId) {
      onProgress(progress)
    }
  })

  try {
    return await run({
      downloadId,
      signal: controller.signal,
      trackLocalProgress: (totalBytes) =>
        createRemoteDownloadProgressTracker({ downloadId, totalBytes, emit: onProgress })
    })
  } catch (error) {
    if (controller.signal.aborted) {
      reportedCancel = true
      toast.message(translate('remoteDownload.progress.canceled', 'Download canceled'), {
        id: toastId,
        duration: 4000,
        description: undefined,
        action: undefined
      })
      return { canceled: true }
    }
    throw error
  } finally {
    settled = true
    unsubscribe()
    if (showTimer) {
      clearTimeout(showTimer)
    }
    if (visible && !reportedCancel) {
      toast.dismiss(toastId)
    }
  }
}
