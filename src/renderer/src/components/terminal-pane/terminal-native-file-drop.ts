import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-import-client'
import { translate } from '@/i18n/i18n'
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
  resolveTerminalDropTargetShell
} from './terminal-drop-shell'
import { isTerminalDropWindowsPathLike } from '../../../../shared/image-path-paste'
import { writeTerminalDropPathsToCapturedTarget } from './terminal-drop-path-writer'
import { showTerminalDropWriteFailure } from './terminal-drop-write-failure'
import { joinRuntimeTerminalDropDir } from './terminal-drop-worktree-path'
import type { captureTerminalDropTransportOwner } from './terminal-drop-transport-owner'
import { toLocalWslDropPath } from './terminal-drop-local-wsl'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'

export async function deliverNativeTerminalFileDrop(
  args: NativeDropFlowArgs & {
    owner: ReturnType<typeof captureTerminalDropTransportOwner>
    worktreeId: string
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
    worktreeId: string
  }
): Promise<void> {
  const targetShell = getTerminalTargetShellForWorktreePath(args.worktreePath)
  const destinationDir = joinRuntimeTerminalDropDir(args.worktreePath)
  const pending = toast.loading(
    args.dataPaths.length === 1
      ? translate(
          'auto.components.terminal.pane.terminal.drop.handler.uploadingFiles_one',
          'Uploading {{count}} file to runtime…',
          { count: args.dataPaths.length }
        )
      : translate(
          'auto.components.terminal.pane.terminal.drop.handler.uploadingFiles_other',
          'Uploading {{count}} files to runtime…',
          { count: args.dataPaths.length }
        )
  )
  try {
    const { results } = await importExternalPathsToRuntime(
      {
        // Use the destination worktree’s owner, which may differ from the focused sidebar host.
        target: runtimeTargetForOwnerEnvironment(args.runtimeEnvironmentId),
        worktreeId: args.worktreeId,
        worktreePath: args.worktreePath,
        expectedExecutionHostId: args.expectedExecutionHostId,
        expectedSshTargetId: args.expectedSshTargetId,
        expectedSshConnectionGeneration: args.expectedSshConnectionGeneration
      },
      args.dataPaths,
      destinationDir,
      { assertCurrent: args.assertCurrent, nameExtensionlessImages: true }
    )
    const imported = results.filter((result) => result.status === 'imported')
    const importedPaths = imported.map((result) =>
      isTerminalDropWindowsPathLike(args.worktreePath)
        ? result.destPath.replace(/\//g, '\\')
        : result.destPath
    )
    await pasteResolvedDropPaths({ ...args, paths: importedPaths, targetShell })
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
  args: NativeDropFlowArgs & {
    localWslDrop: boolean
    targetShell: 'posix' | 'windows'
  }
): Promise<void> {
  // Local WSL shells need distro-aware POSIX paths despite their Windows host.
  if (isWslUncPath(args.worktreePath)) {
    try {
      const { resolvedPaths, skipped, failed } = await window.api.fs.resolveDroppedPathsForAgent({
        paths: args.dataPaths,
        worktreePath: args.worktreePath
      })
      await pasteResolvedDropPaths({ ...args, paths: resolvedPaths, targetShell: 'posix' })
      reportTerminalDropUploadSkipsAndFailures(skipped, failed)
    } catch (err) {
      toast.error(extractIpcErrorMessage(err, 'Failed to resolve dropped files.'))
    }
    return
  }

  // Keep non-WSL local paths in place; trailing spaces separate multiple dropped paths.
  await pasteResolvedDropPaths({
    ...args,
    paths: args.localWslDrop ? args.dataPaths.map(toLocalWslDropPath) : args.dataPaths,
    targetShell: args.targetShell
  })
}

async function uploadRemoteDropPaths(
  args: NativeDropFlowArgs & {
    connectionId: string
    targetShell: 'posix' | 'windows'
  }
): Promise<void> {
  const pending = toast.loading(
    args.dataPaths.length === 1
      ? translate(
          'auto.components.terminal.pane.terminal.drop.handler.uploadingFilesToRemote_one',
          'Uploading {{count}} file to remote…',
          { count: args.dataPaths.length }
        )
      : translate(
          'auto.components.terminal.pane.terminal.drop.handler.uploadingFilesToRemote_other',
          'Uploading {{count}} files to remote…',
          { count: args.dataPaths.length }
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
    await pasteResolvedDropPaths({ ...args, paths: resolvedPaths, targetShell: args.targetShell })
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
    targetShell: 'posix' | 'windows'
  }
): Promise<void> {
  args.assertCurrent?.()
  // Upload/resolution can outlive the pane; recheck before writing to its PTY.
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
    targetShell: args.targetShell
  })
  showTerminalDropWriteFailure(writeResult.failureReason)
  if (writeResult.sentAnyPath) {
    recordTerminalUserInputForLeaf(args.tabId, args.pane.leafId)
  }
}
