import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-import-client'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { PtyTransport } from './pty-transport-types'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { reportTerminalDropUploadSkipsAndFailures } from './terminal-drop-upload-report'
import {
  type captureTerminalDropTarget,
  getCurrentTerminalDropTransport
} from './terminal-drop-target'
import {
  getTerminalTargetShellForWorktreePath,
  isTerminalDropWindowsPathLike,
  resolveTerminalDropInputShell,
  resolveTerminalDropTargetShell,
  type TerminalDropRemoteHost,
  type TerminalTargetShell
} from './terminal-drop-shell'
import { writeTerminalDropPathsToCapturedTarget } from './terminal-drop-path-writer'
import { hasTerminalDropControlByte } from './terminal-drop-path-quoting'
import { showTerminalDropWriteFailure } from './terminal-drop-write-failure'
import { joinRuntimeTerminalDropDir } from './terminal-drop-worktree-path'
import type { captureTerminalDropTransportOwner } from './terminal-drop-transport-owner'
import { toLocalWslDropPath } from './terminal-drop-local-wsl'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'

export async function deliverNativeTerminalFileDrop(
  args: NativeDropFlowArgs & {
    owner: ReturnType<typeof captureTerminalDropTransportOwner>
    localWslDrop: boolean
  }
): Promise<void> {
  const {
    manager,
    paneTransports,
    worktreeId,
    tabId,
    pane,
    dataPaths,
    dropTarget,
    owner,
    worktreePath,
    localWslDrop
  } = args
  // Why before upload: the writer refuses these anyway, and an upload would
  // leave the copies in the worktree's drop folder after a "cancelled" toast.
  if (dataPaths.some(hasTerminalDropControlByte)) {
    showTerminalDropWriteFailure('control-character-path')
    return
  }
  if (owner?.runtimeEnvironmentId) {
    await uploadRuntimeDropPaths({
      dataPaths,
      dropTarget,
      manager,
      paneTransports,
      pane,
      tabId,
      worktreeId,
      worktreePath,
      ...owner,
      runtimeEnvironmentId: owner.runtimeEnvironmentId
    })
    return
  }

  const connectionId = owner?.connectionId
  if (connectionId === undefined) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.drop.handler.0c77693641',
        'Worktree not ready — try again in a moment.'
      )
    )
    return
  }
  const targetShell = resolveTerminalDropTargetShell({
    activeRuntimeEnvironmentId: null,
    worktreePath,
    connectionId
  })
  const isRemote = connectionId !== null

  if (!isRemote) {
    await pasteLocalDropPaths({
      dataPaths,
      dropTarget,
      localWslDrop,
      manager,
      paneTransports,
      pane,
      assertCurrent: owner?.assertCurrent,
      worktreeId,
      tabId,
      targetShell: localWslDrop ? 'posix' : targetShell,
      worktreePath
    })
    return
  }

  await uploadRemoteDropPaths({
    ...owner,
    connectionId,
    dataPaths,
    dropTarget,
    manager,
    paneTransports,
    pane,
    worktreeId,
    tabId,
    targetShell,
    worktreePath
  })
}

export type NativeDropFlowArgs = {
  dataPaths: string[]
  dropTarget: ReturnType<typeof captureTerminalDropTarget>
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  pane: { id: number; leafId: string }
  worktreeId: string
  tabId: string
  worktreePath: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  assertCurrent?: () => void
}

async function uploadRuntimeDropPaths(
  args: NativeDropFlowArgs & {
    runtimeEnvironmentId: string
  }
): Promise<void> {
  const targetShell = getTerminalTargetShellForWorktreePath(args.worktreePath)
  const destinationDir = joinRuntimeTerminalDropDir(args.worktreePath)
  const pending = toast.loading(
    translate(
      'auto.components.terminal.pane.terminal.drop.handler.29c031b49a',
      'Uploading {{value0}} file{{value1}} to runtime…',
      { value0: args.dataPaths.length, value1: args.dataPaths.length === 1 ? '' : 's' }
    )
  )
  try {
    const { results } = await importExternalPathsToRuntime(
      {
        // Why: drops into existing worktrees must follow the worktree owner,
        // not the currently focused host in the sidebar.
        target: runtimeTargetForOwnerEnvironment(args.runtimeEnvironmentId),
        worktreeId: args.worktreeId,
        worktreePath: args.worktreePath,
        expectedExecutionHostId: args.expectedExecutionHostId,
        expectedSshTargetId: args.expectedSshTargetId,
        expectedSshConnectionGeneration: args.expectedSshConnectionGeneration
      },
      args.dataPaths,
      destinationDir,
      { assertCurrent: args.assertCurrent }
    )
    const imported = results.filter((result) => result.status === 'imported')
    const importedPaths = imported.map((result) =>
      isTerminalDropWindowsPathLike(args.worktreePath)
        ? result.destPath.replace(/\//g, '\\')
        : result.destPath
    )
    await pasteResolvedDropPaths({
      ...args,
      paths: importedPaths,
      targetShell,
      remoteHost: { runtimeEnvironmentId: args.runtimeEnvironmentId }
    })
    reportTerminalDropUploadSkipsAndFailures(
      results.filter((result) => result.status === 'skipped'),
      results.filter((result) => result.status === 'failed')
    )
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'))
  } finally {
    toast.dismiss(pending)
  }
}

async function pasteLocalDropPaths(
  args: NativeDropFlowArgs & { localWslDrop: boolean; targetShell: TerminalTargetShell }
): Promise<void> {
  // Why: local WSL worktrees run POSIX shells despite a Windows host, so
  // dropped paths must use the distro-aware resolver before terminal paste.
  if (isWslUncPath(args.worktreePath)) {
    try {
      const { resolvedPaths, skipped, failed } = await window.api.fs.resolveDroppedPathsForAgent({
        paths: args.dataPaths,
        worktreePath: args.worktreePath
      })
      await pasteResolvedDropPaths({
        ...args,
        paths: resolvedPaths,
        targetShell: 'posix',
        remoteHost: null
      })
      reportTerminalDropUploadSkipsAndFailures(skipped, failed)
    } catch (err) {
      toast.error(extractIpcErrorMessage(err, 'Failed to resolve dropped files.'))
    }
    return
  }

  // Why: non-WSL local drops stay reference-in-place. Trailing space
  // separates multiple paths, matching standard drag-and-drop UX.
  await pasteResolvedDropPaths({
    ...args,
    paths: args.localWslDrop ? args.dataPaths.map(toLocalWslDropPath) : args.dataPaths,
    targetShell: args.targetShell,
    remoteHost: null
  })
}

async function uploadRemoteDropPaths(
  args: NativeDropFlowArgs & { connectionId: string; targetShell: TerminalTargetShell }
): Promise<void> {
  const pending = toast.loading(
    translate(
      'auto.components.terminal.pane.terminal.drop.handler.29c031b49a',
      'Uploading {{value0}} file{{value1}} to remote…',
      { value0: args.dataPaths.length, value1: args.dataPaths.length === 1 ? '' : 's' }
    )
  )
  try {
    const { resolvedPaths, skipped, failed } = await window.api.fs.resolveDroppedPathsForAgent({
      paths: args.dataPaths,
      worktreePath: args.worktreePath,
      connectionId: args.connectionId,
      expectedExecutionHostId: args.expectedExecutionHostId,
      expectedSshTargetId: args.expectedSshTargetId,
      expectedSshConnectionGeneration: args.expectedSshConnectionGeneration
    })
    await pasteResolvedDropPaths({
      ...args,
      paths: resolvedPaths,
      targetShell: args.targetShell,
      remoteHost: { runtimeEnvironmentId: null }
    })
    reportTerminalDropUploadSkipsAndFailures(skipped, failed)
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'))
  } finally {
    toast.dismiss(pending)
  }
}

async function pasteResolvedDropPaths(
  args: NativeDropFlowArgs & {
    paths: string[]
    targetShell: TerminalTargetShell
    remoteHost: TerminalDropRemoteHost
  }
): Promise<void> {
  args.assertCurrent?.()
  // Why: pane may have unmounted during upload/resolution (tab closed,
  // worktree switched). Re-check before writing so we do not call sendInput
  // on a torn-down PTY.
  const liveTransport = getCurrentTerminalDropTransport(
    args.manager,
    args.paneTransports,
    args.dropTarget
  )
  if (!liveTransport) {
    return
  }
  const writeResult = await writeTerminalDropPathsToCapturedTarget({
    dropTarget: args.dropTarget,
    manager: args.manager,
    paneTransports: args.paneTransports,
    paths: args.paths,
    targetShell: args.targetShell,
    inputShell: resolveTerminalDropInputShell({
      targetShell: args.targetShell,
      remoteHost: args.remoteHost,
      state: useAppStore.getState(),
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      transport: args.dropTarget.transport
    })
  })
  showTerminalDropWriteFailure(writeResult.failureReason)
  if (writeResult.sentAnyPath) {
    recordTerminalUserInputForLeaf(args.tabId, args.pane.leafId)
  }
}
