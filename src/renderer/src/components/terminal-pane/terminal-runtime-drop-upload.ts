import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { createUploadProgressPanel } from '@/components/transfer-progress/upload-progress-panel'
import type { NativeDropFlowArgs } from './terminal-drop-paste'
import { pasteResolvedDropPaths } from './terminal-drop-paste'
import { describeDropWorkspaceIfInactive } from './terminal-drop-workspace-label'
import { reportTerminalDropUploadSkipsAndFailures } from './terminal-drop-upload-report'
import {
  getTerminalTargetShellForWorktreePath,
  isTerminalDropWindowsPathLike
} from './terminal-drop-shell'
import { joinRuntimeTerminalDropDir } from './terminal-drop-worktree-path'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'

export async function uploadRuntimeDropPaths(
  args: NativeDropFlowArgs & {
    runtimeEnvironmentId: string
    worktreeId: string
  }
): Promise<void> {
  const targetShell = getTerminalTargetShellForWorktreePath(args.worktreePath)
  const destinationDir = joinRuntimeTerminalDropDir(args.worktreePath)
  const panel = createUploadProgressPanel({ worktreeId: args.worktreeId })
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
      {
        assertCurrent: args.assertCurrent,
        progress: panel.progress
      }
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
      // Why: a cancel is the user's own decision, not a failure to report back.
      results
        .filter((result) => result.status === 'failed')
        .filter((result) => result.cancelled !== true),
      describeDropWorkspaceIfInactive(args.worktreeId, args.worktreePath)
    )
  } catch (err) {
    // Why: only the error path tears the panel down immediately. On success it
    // owns its own exit, holding long enough to show how the drop ended.
    panel.close()
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'), {
      description: describeDropWorkspaceIfInactive(args.worktreeId, args.worktreePath)
    })
  }
}
