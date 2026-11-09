import { useCallback, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { createNonSecureContextUuid } from '../../../../../../shared/non-secure-context-uuid'
import { getRevealInFileManagerLabel, revealInFileManager } from '@/lib/reveal-in-file-manager'
import {
  isKnownCloudEnvironment,
  refreshCloudEnvironmentIds
} from '@/lib/cloud-remote-desktop/cloud-environment-ids'
import { getRemoteFileArgs } from '@/runtime/files/runtime-file-routing'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  getRuntimeDownloadProgress,
  subscribeRuntimeDownloadProgress,
  trackRuntimeDownload
} from '@/runtime/files/downloads/runtime-download-progress-store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import {
  canOpenRuntimeDownloadLocally,
  type RuntimeDownloadResult
} from '../../../../../../shared/runtime-downloads/runtime-download-contract'
import { requestFileExplorerRefresh } from '../watching/file-explorer-refresh-requests'
import type { TreeNode } from '../tree/file-explorer-types'
import {
  RuntimeDownloadToast,
  type RuntimeDownloadToastAction,
  type RuntimeDownloadToastIntent,
  type RuntimeDownloadToastState
} from './runtime-download-toast'

export type RuntimeDownloadIntent = RuntimeDownloadToastIntent

// Long enough to reach "Reveal in Finder" after a long download, short enough not to pile up.
// Errors stay until dismissed: their one next action must not time out.
const DONE_TOAST_MS = 12_000

// One transfer per path and intent: "Open on This Computer" has no dialog, so a double click or a
// retry while the first copy still runs would otherwise fetch and open it twice.
const inFlight = new Set<string>()

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

/** Progress toast body bound to the live progress store. */
function LiveProgressToast({
  downloadId,
  state,
  onAction
}: {
  downloadId: string
  state: Omit<Extract<RuntimeDownloadToastState, { kind: 'progress' }>, 'snapshot'>
  onAction: (action: RuntimeDownloadToastAction) => void
}): React.JSX.Element {
  // Stable identities: an inline subscribe would resubscribe on every progress tick.
  const subscribe = useCallback(
    (listener: () => void) => subscribeRuntimeDownloadProgress(downloadId, listener),
    [downloadId]
  )
  const getSnapshot = useCallback(() => getRuntimeDownloadProgress(downloadId), [downloadId])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  return (
    <RuntimeDownloadToast
      state={{ ...state, snapshot }}
      revealLabel=""
      onAction={onAction}
      onDismiss={() => {}}
    />
  )
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
  const environmentId = remote.target.environmentId
  const flightKey = `${environmentId}\u0000${remote.worktreeSelector}\u0000${remote.relativePath}\u0000${intent}`
  if (inFlight.has(flightKey)) {
    return
  }
  inFlight.add(flightKey)
  try {
    await runRuntimeDownload(node, context, intent, options, remote)
  } finally {
    inFlight.delete(flightKey)
  }
}

async function runRuntimeDownload(
  node: TreeNode,
  context: RuntimeFileOperationArgs,
  intent: RuntimeDownloadIntent,
  options: { excludeDefaultDirs?: boolean },
  remote: NonNullable<ReturnType<typeof getRemoteFileArgs>>
): Promise<void> {
  const api = window.api.runtimeDownloads
  if (!api) {
    return
  }
  const environmentId = remote.target.environmentId
  // Error copy says "sandbox" for cloud workspaces; the list is usually primed already.
  void refreshCloudEnvironmentIds()
  const itemKind = node.isDirectory ? 'folder' : 'file'
  const downloadId = createNonSecureContextUuid()
  const toastId = `runtime-download:${downloadId}`
  const release = trackRuntimeDownload(downloadId)
  const excludeDefaultDirs = options.excludeDefaultDirs !== false
  // Timed from the first progress event so the save dialog doesn't count.
  let startedAt = performance.now()
  const pending = api.start({
    downloadId,
    environmentId,
    worktree: remote.worktreeSelector,
    relativePath: remote.relativePath,
    name: node.name,
    kind: itemKind,
    intent,
    excludeDefaultDirs,
    expectedEnvironmentPairingRevision: captureRuntimeEnvironmentRequestRevision(environmentId)
  })
  const progressName = itemKind === 'folder' ? `${node.name}.zip` : node.name
  // The save dialog comes first; show progress only after the user has picked a place.
  const showProgress = (): void => {
    toast.custom(
      () => (
        <LiveProgressToast
          downloadId={downloadId}
          state={{ kind: 'progress', intent, itemKind, name: progressName }}
          onAction={() => void api.cancel({ downloadId })}
        />
      ),
      { id: toastId, duration: Number.POSITIVE_INFINITY, dismissible: false }
    )
  }
  // `preparing` is always the first event and is sent once the save dialog has closed, so the
  // elapsed time never includes the dialog, even for a file too small to send any progress.
  const stopProgressWatch = api.onProgress((event) => {
    if (event.downloadId === downloadId) {
      stopProgressWatch()
      startedAt = performance.now()
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
  const elapsedMs = performance.now() - startedAt
  const outcome = outcomeState(result, { node, itemKind, intent, environmentId, elapsedMs })
  if (!outcome) {
    toast.dismiss(toastId)
    return
  }
  if (result.status === 'error') {
    // Host details stay out of the toast (plain words only) but remain debuggable.
    console.warn('[runtime-download] failed', result.code, result.message)
  }
  if (result.status === 'done' && result.openError) {
    console.warn('[runtime-download] open failed', result.openError)
  }
  const destinationPath = result.status === 'done' ? result.destinationPath : null
  const onAction = (action: RuntimeDownloadToastAction): void => {
    toast.dismiss(toastId)
    if ((action === 'reveal' || action === 'open') && destinationPath) {
      void (action === 'reveal'
        ? revealInFileManager(destinationPath, LOCAL_EXECUTION_HOST_ID)
        : window.api.shell.openPath(destinationPath, LOCAL_EXECUTION_HOST_ID))
    } else if (action === 'retry') {
      void startRuntimeDownload(node, context, intent, options)
    } else if (action === 'download_instead') {
      void startRuntimeDownload(node, context, 'save', options)
    } else if (action === 'refresh') {
      requestFileExplorerRefresh()
    }
  }
  toast.custom(
    () => (
      <RuntimeDownloadToast
        state={outcome}
        revealLabel={getRevealInFileManagerLabel()}
        onAction={onAction}
        onDismiss={() => toast.dismiss(toastId)}
      />
    ),
    {
      id: toastId,
      duration: outcome.kind === 'done' ? DONE_TOAST_MS : Number.POSITIVE_INFINITY,
      dismissible: true
    }
  )
}

/** The toast to leave behind, or null when it should just go away (canceled, opened fine). */
export function outcomeState(
  result: RuntimeDownloadResult,
  input: {
    node: Pick<TreeNode, 'name'>
    itemKind: 'file' | 'folder'
    intent: RuntimeDownloadIntent
    environmentId: string
    elapsedMs: number
  }
): RuntimeDownloadToastState | null {
  const { node, itemKind, intent } = input
  if (result.status === 'canceled') {
    return null
  }
  if (result.status === 'error') {
    return {
      kind: 'failed',
      intent,
      itemKind,
      name: node.name,
      code: result.code,
      place: isKnownCloudEnvironment(input.environmentId) ? 'sandbox' : 'host'
    }
  }
  if (intent === 'open') {
    return result.openError ? { kind: 'no_app', name: node.name } : null
  }
  return {
    kind: 'done',
    itemKind,
    name: localName(result.destinationPath),
    bytes: result.bytes,
    elapsedMs: input.elapsedMs,
    ...(result.fileCount !== undefined ? { fileCount: result.fileCount } : {}),
    excludedDefaultDirs: (result.excludedDirCount ?? 0) > 0,
    canOpen: canOpenRuntimeDownloadLocally(node.name),
    ...(result.skippedCount ? { skippedCount: result.skippedCount } : {})
  }
}
