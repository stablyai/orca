import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { hasUploadLeftovers } from '../../../../shared/ssh-import-cancel-reason'
import { createUploadProgressPanel } from '@/components/transfer-progress/upload-progress-panel'
import { runSshUploadWithProgress } from '@/runtime/ssh-upload-progress-client'
import {
  failuresToReport,
  reportTerminalDropUploadSkipsAndFailures
} from './terminal-drop-upload-report'
import { describeDropWorkspaceIfInactive } from './terminal-drop-workspace-label'
import { pasteResolvedDropPaths, type NativeDropFlowArgs } from './terminal-drop-paste'
import { uploadRuntimeDropPaths } from './terminal-runtime-drop-upload'
import { resolveTerminalDropTargetShell } from './terminal-drop-shell'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import type { captureTerminalDropTransportOwner } from './terminal-drop-transport-owner'
import { toLocalWslDropPath } from './terminal-drop-local-wsl'

export async function deliverNativeTerminalFileDrop(
  args: NativeDropFlowArgs & {
    settings: ReturnType<typeof useAppStore.getState>['settings']
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
    settings,
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
      settings,
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
    connectionId,
    remotePlatform: getTerminalPasteSshRemotePlatform(connectionId)
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
  args: NativeDropFlowArgs & {
    connectionId: string
    targetShell: 'posix' | 'windows'
    worktreeId: string
  }
): Promise<void> {
  const panel = createUploadProgressPanel({ worktreeId: args.worktreeId })
  try {
    const { resolvedPaths, skipped, failed } = await runSshUploadWithProgress(
      args.dataPaths,
      panel.progress,
      (uploadIds) =>
        window.api.fs.resolveDroppedPathsForAgent({
          paths: args.dataPaths,
          worktreePath: args.worktreePath,
          connectionId: args.connectionId,
          expectedExecutionHostId: args.expectedExecutionHostId,
          expectedSshTargetId: args.expectedSshTargetId,
          expectedSshConnectionGeneration: args.expectedSshConnectionGeneration,
          ...(uploadIds ? { uploadIds } : {})
        }),
      (result, sourcePath) => {
        const failure = result.failed.find((item) => item.sourcePath === sourcePath)
        const skipped = result.skipped.some((item) => item.sourcePath === sourcePath)
        return failure || skipped
          ? {
              status: 'failed',
              detail: hasUploadLeftovers(failure?.reason) ? failure?.reason : undefined
            }
          : { status: 'done' }
      }
    )
    await pasteResolvedDropPaths({ ...args, paths: resolvedPaths, targetShell: args.targetShell })
    reportTerminalDropUploadSkipsAndFailures(
      skipped,
      failuresToReport(failed, (item) => item.cancelled === true),
      describeDropWorkspaceIfInactive(args.worktreeId, args.worktreePath)
    )
  } catch (err) {
    panel.close()
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'), {
      description: describeDropWorkspaceIfInactive(args.worktreeId, args.worktreePath)
    })
  }
}
