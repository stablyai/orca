import { toast } from 'sonner'
import { createNonSecureContextUuid } from '../../../../../../shared/non-secure-context-uuid'
import { translate } from '@/i18n/i18n'
import { getRevealInFileManagerLabel, revealInFileManager } from '@/lib/reveal-in-file-manager'
import { getRemoteFileArgs } from '@/runtime/files/runtime-file-routing'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { trackRuntimeDownload } from '@/runtime/files/downloads/runtime-download-progress-store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { formatBytes } from '../../../../../../shared/format-bytes'
import type { RuntimeDownloadResult } from '../../../../../../shared/runtime-downloads/runtime-download-contract'
import type { TreeNode } from '../tree/file-explorer-types'
import { RuntimeDownloadProgressBody, runtimeDownloadErrorMessage } from './runtime-download-toast'

export type RuntimeDownloadIntent = 'save' | 'open'

/** Whether this desktop can stream the node straight from its runtime host. */
export function canStreamRuntimeDownload(
  node: TreeNode,
  context: RuntimeFileOperationArgs | null | undefined
): context is RuntimeFileOperationArgs {
  return Boolean(
    context && window.api.runtimeDownloads && getRemoteFileArgs(context, node.path) !== null
  )
}

function localName(destinationPath: string): string {
  const separator = window.api.platform.get().platform === 'win32' ? /[\\/]/ : /\//
  return destinationPath.split(separator).pop() || destinationPath
}

export async function startRuntimeDownload(
  node: TreeNode,
  context: RuntimeFileOperationArgs,
  intent: RuntimeDownloadIntent,
  options: { excludeDefaultDirs?: boolean } = {}
): Promise<void> {
  const api = window.api.runtimeDownloads
  const remote = getRemoteFileArgs(context, node.path)
  if (!api || !remote) {
    return
  }
  const kind = node.isDirectory ? 'folder' : 'file'
  const downloadId = createNonSecureContextUuid()
  const toastId = `runtime-download:${downloadId}`
  const release = trackRuntimeDownload(downloadId)
  const excludeDefaultDirs = options.excludeDefaultDirs !== false
  const pending = api.start({
    downloadId,
    environmentId: remote.target.environmentId,
    worktree: remote.worktreeSelector,
    relativePath: remote.relativePath,
    name: node.name,
    kind,
    intent,
    excludeDefaultDirs,
    expectedEnvironmentPairingRevision: captureRuntimeEnvironmentRequestRevision(
      remote.target.environmentId
    )
  })
  // The save dialog comes first; show progress only after the user has picked a place.
  const showProgress = (): void => {
    toast.loading(
      intent === 'open'
        ? translate(
            'auto.components.right.sidebar.runtimeDownload.opening',
            "Opening '{{value0}}'",
            {
              value0: node.name
            }
          )
        : translate(
            'auto.components.right.sidebar.runtimeDownload.downloading',
            "Downloading '{{value0}}'",
            { value0: kind === 'folder' ? `${node.name}.zip` : node.name }
          ),
      {
        id: toastId,
        description: <RuntimeDownloadProgressBody downloadId={downloadId} kind={kind} />,
        duration: Infinity,
        dismissible: false,
        action: {
          label: translate('auto.components.right.sidebar.runtimeDownload.cancel', 'Cancel'),
          onClick: (event) => {
            event.preventDefault()
            void api.cancel({ downloadId })
          }
        }
      }
    )
  }
  const stopProgressWatch = window.api.runtimeDownloads!.onProgress((event) => {
    if (event.downloadId === downloadId) {
      stopProgressWatch()
      showProgress()
    }
  })
  let result: RuntimeDownloadResult
  try {
    result = await pending
  } catch (error) {
    result = {
      status: 'error',
      code: 'transfer_failed',
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    stopProgressWatch()
    release()
  }
  showOutcome(result, { node, kind, intent, toastId, context, excludeDefaultDirs })
}

function showOutcome(
  result: RuntimeDownloadResult,
  input: {
    node: TreeNode
    kind: 'file' | 'folder'
    intent: RuntimeDownloadIntent
    toastId: string
    context: RuntimeFileOperationArgs
    excludeDefaultDirs: boolean
  }
): void {
  const { node, kind, intent, toastId } = input
  if (result.status === 'canceled') {
    toast.dismiss(toastId)
    return
  }
  if (result.status === 'error') {
    toast.error(
      intent === 'open'
        ? translate(
            'auto.components.right.sidebar.runtimeDownload.openFailed',
            "Couldn't open '{{value0}}'",
            { value0: node.name }
          )
        : translate(
            'auto.components.right.sidebar.runtimeDownload.failed',
            "Couldn't download '{{value0}}'",
            { value0: node.name }
          ),
      {
        id: toastId,
        description: runtimeDownloadErrorMessage(result.code, result.message),
        duration: 8000,
        dismissible: true,
        action: undefined
      }
    )
    return
  }
  const reveal = {
    label: getRevealInFileManagerLabel(),
    onClick: () => void revealInFileManager(result.destinationPath, LOCAL_EXECUTION_HOST_ID)
  }
  if (intent === 'open') {
    if (!result.openError) {
      toast.dismiss(toastId)
      return
    }
    toast.error(
      translate(
        'auto.components.right.sidebar.runtimeDownload.noAppToOpen',
        "No app could open '{{value0}}'",
        { value0: node.name }
      ),
      {
        id: toastId,
        description: result.openError,
        duration: 8000,
        dismissible: true,
        action: reveal
      }
    )
    return
  }
  const parts = [formatBytes(result.bytes)]
  if (kind === 'folder' && result.fileCount !== undefined) {
    parts.push(
      translate('auto.components.right.sidebar.runtimeDownload.fileCount', '{{count}} files', {
        count: result.fileCount,
        defaultValue_one: '{{count}} file'
      })
    )
  }
  if (kind === 'folder' && (result.excludedDirCount ?? 0) > 0) {
    parts.push(
      translate(
        'auto.components.right.sidebar.runtimeDownload.excludedDefaultDirs',
        'without node_modules and .git'
      )
    )
  }
  if ((result.skippedCount ?? 0) > 0) {
    parts.push(
      translate(
        'auto.components.right.sidebar.runtimeDownload.skipped',
        '{{count}} unreadable items skipped',
        { count: result.skippedCount, defaultValue_one: '{{count}} unreadable item skipped' }
      )
    )
  }
  toast.success(
    translate('auto.components.right.sidebar.runtimeDownload.done', "Downloaded '{{value0}}'", {
      value0: localName(result.destinationPath)
    }),
    {
      id: toastId,
      description: parts.join(' · '),
      duration: 8000,
      dismissible: true,
      action: reveal,
      ...(kind === 'file'
        ? {
            cancel: {
              label: translate('auto.components.right.sidebar.runtimeDownload.open', 'Open'),
              onClick: () =>
                void window.api.shell.openPath(result.destinationPath, LOCAL_EXECUTION_HOST_ID)
            }
          }
        : {})
    }
  )
}
