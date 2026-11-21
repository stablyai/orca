import { toast } from 'sonner'

import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { stageClientFilesForAgent } from '@/runtime/files/imports/agent-file-staging'
import { translate } from '@/i18n/i18n'
import { parseWslUncPath, toWindowsWslPath } from '../../../../../../shared/file-access/wsl-paths'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { recordTerminalUserInputForLeaf } from '../terminal-input-activity'
import { reportTerminalDropUploadSkipsAndFailures } from './terminal-drop-upload-report'
import {
  type captureTerminalDropTarget,
  getCurrentTerminalDropTransport
} from './terminal-drop-target'
import {
  getTerminalTargetShellForWorktreePath,
  resolveTerminalDropTargetShell
} from './terminal-drop-shell'
import { writeTerminalDropPathsToCapturedTarget } from './terminal-drop-path-writer'
import { showTerminalDropWriteFailure } from './terminal-drop-write-failure'
import type { captureTerminalDropTransportOwner } from './terminal-drop-transport-owner'
import { toLocalWslDropPath } from './terminal-drop-local-wsl'
import { terminalFileDropErrorMessage } from './terminal-native-file-drop-error'
import { recordRecentTerminalImage } from '../recent-terminal-images'

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
  const pending = toast.loading(
    translate(
      'auto.components.terminal.pane.terminal.drop.handler.uploadingFiles',
      'Uploading {{count}} files to runtime…',
      { count: args.dataPaths.length, defaultValue_one: 'Uploading {{count}} file to runtime…' }
    )
  )
  try {
    const { staged, skipped, failed } = await stageClientFilesForAgent(
      {
        // Use the destination worktree’s owner, which may differ from the focused sidebar host.
        runtimeEnvironmentId: args.runtimeEnvironmentId,
        worktreeId: args.worktreeId,
        worktreePath: args.worktreePath,
        expectedExecutionHostId: args.expectedExecutionHostId,
        expectedSshTargetId: args.expectedSshTargetId,
        expectedSshConnectionGeneration: args.expectedSshConnectionGeneration
      },
      args.dataPaths,
      args.assertCurrent
    )
    await pasteResolvedDropPaths({
      ...args,
      paths: staged.map(({ hostPath }) => hostPath),
      targetShell
    })
    reportTerminalDropUploadSkipsAndFailures(skipped, failed)
  } catch (err) {
    toast.error(terminalFileDropErrorMessage(err, 'upload'))
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
  const wsl = parseWslUncPath(args.worktreePath)
  if (wsl) {
    try {
      const { resolvedPaths, skipped, failed } = await window.api.fs.resolveDroppedPathsForAgent({
        paths: args.dataPaths,
        worktreePath: args.worktreePath
      })
      await pasteResolvedDropPaths({
        ...args,
        paths: resolvedPaths,
        targetShell: 'posix',
        previewPaths: resolvedPaths.map((path) => toWindowsWslPath(path, wsl.distro))
      })
      reportTerminalDropUploadSkipsAndFailures(skipped, failed)
    } catch (err) {
      toast.error(terminalFileDropErrorMessage(err, 'resolve'))
    }
    return
  }

  // Keep non-WSL local paths in place; trailing spaces separate multiple dropped paths.
  await pasteResolvedDropPaths({
    ...args,
    paths: args.localWslDrop ? args.dataPaths.map(toLocalWslDropPath) : args.dataPaths,
    targetShell: args.targetShell,
    previewPaths: args.dataPaths
  })
}

async function uploadRemoteDropPaths(
  args: NativeDropFlowArgs & {
    connectionId: string
    targetShell: 'posix' | 'windows'
  }
): Promise<void> {
  const pending = toast.loading(
    translate(
      'auto.components.terminal.pane.terminal.drop.handler.uploadingFilesToRemote',
      'Uploading {{count}} files to remote…',
      { count: args.dataPaths.length, defaultValue_one: 'Uploading {{count}} file to remote…' }
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
    toast.error(terminalFileDropErrorMessage(err, 'upload'))
  } finally {
    toast.dismiss(pending)
  }
}

async function pasteResolvedDropPaths(
  args: NativeDropFlowArgs & {
    paths: string[]
    previewPaths?: readonly string[]
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
    tabId: args.tabId,
    manager: args.manager,
    paneTransports: args.paneTransports,
    paths: args.paths,
    targetShell: args.targetShell
  })
  showTerminalDropWriteFailure(writeResult.failureReason)
  if (writeResult.sentAnyPath) {
    recordTerminalUserInputForLeaf(args.tabId, args.pane.leafId)
    if (
      args.previewPaths &&
      getCurrentTerminalDropTransport(args.manager, args.paneTransports, args.dropTarget)
    ) {
      const pane = args.manager
        .getPanes()
        .find((candidate) => candidate.leafId === args.pane.leafId)
      if (pane) {
        for (const path of args.previewPaths.slice(0, writeResult.pathsWritten)) {
          recordRecentTerminalImage(pane.terminal, path)
        }
      }
    }
  }
}
