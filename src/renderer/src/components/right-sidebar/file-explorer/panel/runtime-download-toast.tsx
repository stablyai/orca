import { useSyncExternalStore } from 'react'
import { Progress } from '@/components/ui/progress'
import { useTranslate } from '@/i18n/use-translate'
import { translate } from '@/i18n/i18n'
import { formatBytes } from '../../../../../../shared/format-bytes'
import type { RuntimeDownloadErrorCode } from '../../../../../../shared/runtime-downloads/runtime-download-contract'
import {
  getRuntimeDownloadProgress,
  subscribeRuntimeDownloadProgress,
  type RuntimeDownloadProgressSnapshot
} from '@/runtime/files/downloads/runtime-download-progress-store'

/** Fraction done, or null while the size is unknown (folder walk, empty file). */
export function runtimeDownloadFraction(
  snapshot: RuntimeDownloadProgressSnapshot | null
): number | null {
  if (!snapshot || snapshot.phase !== 'transferring' || !snapshot.totalBytes) {
    return null
  }
  return Math.min(1, snapshot.processedBytes / snapshot.totalBytes)
}

export function RuntimeDownloadProgressBody({
  downloadId,
  kind
}: {
  downloadId: string
  kind: 'file' | 'folder'
}): React.JSX.Element {
  const t = useTranslate()
  const snapshot = useSyncExternalStore(
    (listener) => subscribeRuntimeDownloadProgress(downloadId, listener),
    () => getRuntimeDownloadProgress(downloadId)
  )
  const fraction = runtimeDownloadFraction(snapshot)
  const percent = fraction === null ? null : Math.round(fraction * 100)
  const progressLabel = t(
    'auto.components.right.sidebar.runtimeDownload.progressLabel',
    'Download progress'
  )
  let detail: string
  if (!snapshot || snapshot.phase === 'preparing') {
    detail =
      kind === 'folder'
        ? t('auto.components.right.sidebar.runtimeDownload.preparingFolder', 'Collecting files…')
        : t('auto.components.right.sidebar.runtimeDownload.preparingFile', 'Starting…')
  } else {
    const received = formatBytes(snapshot.receivedBytes)
    const rate =
      snapshot.bytesPerSecond && snapshot.bytesPerSecond > 0
        ? t('auto.components.right.sidebar.runtimeDownload.rate', '{{value0}}/s', {
            value0: formatBytes(snapshot.bytesPerSecond)
          })
        : null
    const amount =
      kind === 'file' && snapshot.totalBytes
        ? t(
            'auto.components.right.sidebar.runtimeDownload.amountOfTotal',
            '{{value0}} of {{value1}}',
            {
              value0: received,
              value1: formatBytes(snapshot.totalBytes)
            }
          )
        : received
    detail = rate ? `${amount} · ${rate}` : amount
  }
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5 pt-1">
      {percent === null ? (
        // Unknown size: an honest sweep beats a faked percentage.
        <span
          role="progressbar"
          aria-label={progressLabel}
          aria-valuetext={detail}
          className="block h-1.5 w-full overflow-hidden rounded-full bg-primary/20"
        >
          <span className="block h-full w-2/5 animate-[skill-update-slide_1.35s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
        </span>
      ) : (
        <Progress
          value={percent}
          aria-label={progressLabel}
          aria-valuetext={`${percent}%, ${detail}`}
          className="h-1.5"
        />
      )}
      <p className="truncate text-xs tabular-nums text-muted-foreground">{detail}</p>
    </div>
  )
}

export function runtimeDownloadErrorMessage(
  code: RuntimeDownloadErrorCode,
  hostMessage: string
): string {
  switch (code) {
    case 'too_large':
      return translate(
        'auto.components.right.sidebar.runtimeDownload.errorTooLarge',
        'It is larger than the 2 GB download limit. Download smaller folders or individual files.'
      )
    case 'too_many_entries':
      return translate(
        'auto.components.right.sidebar.runtimeDownload.errorTooManyEntries',
        'It has more than 65,000 files and folders. Download a smaller folder.'
      )
    case 'host_update_required':
      return translate(
        'auto.components.right.sidebar.runtimeDownload.errorHostUpdate',
        'The remote host runs an older Orca server that cannot do this. Update it and try again.'
      )
    case 'host_busy':
      return translate(
        'auto.components.right.sidebar.runtimeDownload.errorBusy',
        'Too many downloads are running. Wait for one to finish and try again.'
      )
    case 'not_found':
      return translate(
        'auto.components.right.sidebar.runtimeDownload.errorNotFound',
        'It no longer exists on the remote host.'
      )
    case 'not_a_file':
    case 'not_a_directory':
      return translate(
        'auto.components.right.sidebar.runtimeDownload.errorChanged',
        'It changed on the remote host. Refresh the file explorer and try again.'
      )
    case 'disconnected':
      return translate(
        'auto.components.right.sidebar.runtimeDownload.errorDisconnected',
        'The connection to the remote host was lost. Reconnect and try again.'
      )
    case 'open_failed':
    case 'transfer_failed':
    case 'canceled':
      return hostMessage
  }
}
