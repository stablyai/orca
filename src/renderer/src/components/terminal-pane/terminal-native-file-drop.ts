import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { isWslUncPath, parseWslUncPath } from '../../../../shared/wsl-paths'
import type { PtyTransport } from './pty-transport'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { reportTerminalDropUploadSkipsAndFailures } from './terminal-drop-upload-report'
import { captureTerminalDropTarget, getCurrentTerminalDropTransport } from './terminal-drop-target'
import {
  getTerminalTargetShellForWorktreePath,
  isTerminalDropWindowsPathLike,
  resolveTerminalDropTargetShell
} from './terminal-drop-shell'
import { writeTerminalDropPathsToCapturedTarget } from './terminal-drop-path-writer'
import { resolveNativeTerminalDropPane } from './terminal-drop-pane-resolution'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { showTerminalDropWriteFailure } from './terminal-drop-write-failure'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import {
  joinRuntimeTerminalDropDir,
  resolveTerminalDropWorktreePath
} from './terminal-drop-worktree-path'
import { captureRuntimeTerminalDropOwner } from './terminal-drop-runtime-owner'

export type NativeTerminalFileDropArgs = {
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  worktreeId: string
  tabId: string
  cwd: string | undefined
  data: { paths: string[]; target: string; tabId?: string; paneLeafId?: string }
}

/**
 * Handle a native file drop targeted at a terminal pane.
 *
 * Local worktrees: paste the local absolute path (reference-in-place; no copy
 * or IPC). SSH worktrees: upload each file into `${worktreePath}/.orca/drops`
 * and paste the remote path so the remote agent can read it. See
 * docs/terminal-drop-ssh.md.
 */
export async function handleNativeTerminalFileDrop(
  args: NativeTerminalFileDropArgs
): Promise<void> {
  try {
    await handleNativeTerminalFileDropWithCapturedOwner(args)
  } catch (err) {
    // Why: native drop listeners fire-and-forget, so owner-capture failures must terminate here.
    toast.error(extractIpcErrorMessage(err, 'Failed to drop files.'))
  }
}

async function handleNativeTerminalFileDropWithCapturedOwner(
  args: NativeTerminalFileDropArgs
): Promise<void> {
  const { manager, paneTransports, worktreeId, tabId, cwd, data } = args
  if (data.paths.length === 0) {
    return
  }
  const pane = resolveNativeTerminalDropPane(manager, data.paneLeafId)
  if (!pane) {
    return
  }
  const transport = paneTransports.get(pane.id)
  if (!transport) {
    return
  }
  const dropTarget = captureTerminalDropTarget(pane, transport)
  const state = useAppStore.getState()
  const settings = state.settings
  const runtimeOwner = captureRuntimeTerminalDropOwner(worktreeId)
  const worktreePath = resolveTerminalDropWorktreePath(worktreeId, cwd)
  if (!worktreePath) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.drop.handler.ce8248b835',
        'Worktree path not available.'
      )
    )
    return
  }

  if (runtimeOwner) {
    await uploadRuntimeDropPaths({
      dataPaths: data.paths,
      dropTarget,
      manager,
      paneTransports,
      pane,
      settings,
      tabId,
      worktreeId,
      worktreePath,
      ...runtimeOwner
    })
    return
  }

  // Why: `getConnectionId` returns `string` (SSH), `null` (local repo found),
  // or `undefined` (store not hydrated / worktree not found). Treat
  // `undefined` as an error — otherwise a drop during hydration would
  // silently paste local paths into a remote shell.
  const connectionId = getConnectionId(worktreeId)
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
    connectionId,
    remotePlatform: getTerminalPasteSshRemotePlatform(connectionId)
  })
  const isRemote = connectionId !== null
  const localWslDrop = !isRemote && isWorktreeUsingLocalWslRuntime(state, worktreeId)

  if (!isRemote) {
    await pasteLocalDropPaths({
      dataPaths: data.paths,
      dropTarget,
      localWslDrop,
      manager,
      paneTransports,
      pane,
      tabId,
      targetShell: localWslDrop ? 'posix' : targetShell,
      worktreePath
    })
    return
  }

  await uploadRemoteDropPaths({
    connectionId,
    ...captureDirectSshMutationExpectation(state, connectionId),
    dataPaths: data.paths,
    dropTarget,
    manager,
    paneTransports,
    pane,
    tabId,
    targetShell,
    worktreePath
  })
}

type NativeDropFlowArgs = {
  dataPaths: string[]
  dropTarget: ReturnType<typeof captureTerminalDropTarget>
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  pane: ReturnType<typeof resolveNativeTerminalDropPane> & {}
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
    settings: ReturnType<typeof useAppStore.getState>['settings']
    worktreeId: string
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
        settings: { ...args.settings, activeRuntimeEnvironmentId: args.runtimeEnvironmentId },
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
  args: NativeDropFlowArgs & { localWslDrop: boolean; targetShell: 'posix' | 'windows' }
): Promise<void> {
  // Why: local WSL worktrees run POSIX shells despite a Windows host, so
  // dropped paths must use the distro-aware resolver before terminal paste.
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

  // Why: non-WSL local drops stay reference-in-place. Trailing space
  // separates multiple paths, matching standard drag-and-drop UX.
  await pasteResolvedDropPaths({
    ...args,
    paths: args.localWslDrop ? args.dataPaths.map(toLocalWslDropPath) : args.dataPaths,
    targetShell: args.targetShell
  })
}

async function uploadRemoteDropPaths(
  args: NativeDropFlowArgs & { connectionId: string; targetShell: 'posix' | 'windows' }
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
    await pasteResolvedDropPaths({ ...args, paths: resolvedPaths, targetShell: args.targetShell })
    reportTerminalDropUploadSkipsAndFailures(skipped, failed)
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'))
  } finally {
    toast.dismiss(pending)
  }
}

async function pasteResolvedDropPaths(
  args: NativeDropFlowArgs & { paths: string[]; targetShell: 'posix' | 'windows' }
): Promise<void> {
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
    targetShell: args.targetShell
  })
  showTerminalDropWriteFailure(writeResult.failureReason)
  if (writeResult.sentAnyPath) {
    recordTerminalUserInputForLeaf(args.tabId, args.pane.leafId)
  }
  if (writeResult.targetCurrent) {
    args.pane.terminal.focus()
  }
}

function isWorktreeUsingLocalWslRuntime(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): boolean {
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId, CLIENT_PLATFORM)
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl'
  }
  return projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
}

function toLocalWslDropPath(path: string): string {
  const wslUnc = parseWslUncPath(path)
  if (wslUnc) {
    return wslUnc.linuxPath
  }
  if (isWindowsAbsolutePathLike(path)) {
    const drive = path[0].toLowerCase()
    return `/mnt/${drive}/${path.slice(3).replace(/\\/g, '/')}`
  }
  return path.replace(/\\/g, '/')
}
