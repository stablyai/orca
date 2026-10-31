import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { openWorktreeScopedToast } from '@/lib/worktree-scoped-toast'
import { reportTerminalDropUploadSkipsAndFailures } from './terminal-drop-upload-report'
import { describeDropWorkspaceIfInactive } from './terminal-drop-workspace-label'
import { pasteResolvedDropPaths, type NativeDropFlowArgs } from './terminal-drop-paste'
import { uploadRuntimeDropPaths } from './terminal-runtime-drop-upload'
import { resolveTerminalDropTargetShell } from './terminal-drop-shell'
import type { captureTerminalDropTransportOwner } from './terminal-drop-transport-owner'
import { toLocalWslDropPath } from './terminal-drop-local-wsl'

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
    worktreeId,
    worktreePath
  })
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
    worktreeId: string
  }
): Promise<void> {
  const message = translate(
    'auto.components.terminal.pane.terminal.drop.handler.uploadingFilesToRemote',
    'Uploading {{count}} files to remote…',
    { count: args.dataPaths.length, defaultValue_one: 'Uploading {{count}} file to remote…' }
  )
  const pending = openWorktreeScopedToast({
    worktreeId: args.worktreeId,
    show: (id) => (id === undefined ? toast.loading(message) : toast.loading(message, { id }))
  })
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
    reportTerminalDropUploadSkipsAndFailures(
      skipped,
      failed,
      describeDropWorkspaceIfInactive(args.worktreeId, args.worktreePath)
    )
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'), {
      description: describeDropWorkspaceIfInactive(args.worktreeId, args.worktreePath)
    })
  } finally {
    pending.close()
  }
}
