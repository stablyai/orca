import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import {
  isResolvedWorkspaceFileDragExecutionHost,
  readWorkspaceFileDragPaths,
  readWorkspaceFileDragSource
} from '@/lib/workspace-file-drag'
import { captureTerminalDropTarget } from './terminal-drop-target'
import { resolveTerminalDropTargetShell } from './terminal-drop-shell'
import { writeTerminalDropPathsToCapturedTarget } from './terminal-drop-path-writer'
import { resolveInternalTerminalDropPane } from './terminal-drop-pane-resolution'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { showTerminalDropWriteFailure } from './terminal-drop-write-failure'
import type { TerminalDropWriteFailureReason } from './terminal-drop-write-failure'
import { getTerminalInternalFileDropRejectionMessage } from './terminal-drop-internal-rejection-message'
import { resolveTerminalDropWorktreePath } from './terminal-drop-worktree-path'
import {
  handleNativeTerminalFileDrop as handleTerminalFileDrop,
  type NativeTerminalFileDropArgs
} from './terminal-native-file-drop-destination'

export { handleTerminalFileDrop }

type InternalArgs = Omit<NativeTerminalFileDropArgs, 'paths' | 'pane'> & {
  dataTransfer: Pick<DataTransfer, 'getData'>
  dropTarget?: EventTarget | null
  paneLeafId?: string
}

export type InternalTerminalFileDropResult =
  | { status: 'ignored'; reason: 'empty' | 'no-pane' | 'no-transport' | 'worktree-unavailable' }
  | {
      status: 'cancelled'
      reason: TerminalDropWriteFailureReason
      pathCount: number
    }
  | { status: 'pasted'; pathCount: number }
  | { status: 'rejected'; reason: 'paths-too-large' | 'too-many-paths' | 'source-host-mismatch' }

export async function handleInternalTerminalFileDrop({
  manager,
  paneTransports,
  worktreeId,
  tabId,
  cwd,
  dataTransfer,
  dropTarget,
  paneLeafId
}: InternalArgs): Promise<InternalTerminalFileDropResult> {
  const dragPaths = readWorkspaceFileDragPaths(dataTransfer)
  if (dragPaths.status === 'rejected') {
    toast.error(getTerminalInternalFileDropRejectionMessage(dragPaths.reason))
    return { status: 'rejected', reason: dragPaths.reason }
  }

  const paths = dragPaths.paths
  if (paths.length === 0) {
    return { status: 'ignored', reason: 'empty' }
  }

  const pane = resolveInternalTerminalDropPane(manager, dropTarget, paneLeafId)
  if (!pane) {
    return { status: 'ignored', reason: 'no-pane' }
  }
  const transport = paneTransports.get(pane.id)
  if (!transport) {
    return { status: 'ignored', reason: 'no-transport' }
  }
  const host = parseExecutionHostId(transport.getExecutionHostId?.())
  const runtimeEnvironmentId =
    transport.getRuntimeEnvironmentId?.() ?? (host?.kind === 'runtime' ? host.environmentId : null)
  // A paired host's local terminal belongs to that host, not this desktop.
  const targetExecutionHostId =
    host?.kind === 'local' && runtimeEnvironmentId
      ? toRuntimeExecutionHostId(runtimeEnvironmentId)
      : host?.id
  const source = readWorkspaceFileDragSource(dataTransfer)
  const sourceHost = parseExecutionHostId(source?.executionHostId)
  const sourceRuntimeEnvironmentId =
    source?.runtimeEnvironmentId ??
    (sourceHost?.kind === 'runtime' ? sourceHost.environmentId : null)
  if (
    !source ||
    !isResolvedWorkspaceFileDragExecutionHost(source.executionHostId) ||
    source.executionHostId !== targetExecutionHostId ||
    sourceRuntimeEnvironmentId !== runtimeEnvironmentId ||
    (host?.kind === 'runtime' && runtimeEnvironmentId !== host.environmentId)
  ) {
    toast.error(getTerminalInternalFileDropRejectionMessage('source-host-mismatch'))
    return { status: 'rejected', reason: 'source-host-mismatch' }
  }
  const dropTargetSnapshot = captureTerminalDropTarget(pane, transport)
  const worktreePath = resolveTerminalDropWorktreePath(
    worktreeId,
    runtimeEnvironmentId ? undefined : cwd,
    host?.id,
    runtimeEnvironmentId
  )
  if (!worktreePath) {
    return { status: 'ignored', reason: 'worktree-unavailable' }
  }
  const connectionId = getConnectionId(worktreeId)
  if (!runtimeEnvironmentId && connectionId === undefined) {
    // Why: unresolved connection metadata means we cannot know whether these
    // worktree-owned paths belong to a local, WSL, or SSH terminal.
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.drop.handler.0c77693641',
        'Worktree not ready — try again in a moment.'
      )
    )
    return { status: 'ignored', reason: 'worktree-unavailable' }
  }
  const targetShell = resolveTerminalDropTargetShell({
    activeRuntimeEnvironmentId: runtimeEnvironmentId,
    worktreePath,
    // Why: internal Explorer drags paste worktree-owned paths directly, so SSH
    // shell semantics must come from the remote session, not the client OS.
    connectionId,
    remotePlatform: getTerminalPasteSshRemotePlatform(connectionId)
  })

  const writeResult = await writeTerminalDropPathsToCapturedTarget({
    dropTarget: dropTargetSnapshot,
    manager,
    paneTransports,
    paths,
    targetShell
  })
  showTerminalDropWriteFailure(writeResult.failureReason)
  if (writeResult.sentAnyPath) {
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
  }
  if (writeResult.targetCurrent) {
    pane.terminal.focus()
  }
  if (writeResult.failureReason) {
    return {
      status: 'cancelled',
      reason: writeResult.failureReason,
      pathCount: writeResult.pathsWritten
    }
  }
  return { status: 'pasted', pathCount: writeResult.pathsWritten }
}
