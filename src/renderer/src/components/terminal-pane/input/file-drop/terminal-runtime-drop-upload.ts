import { toast } from 'sonner'
import { stageClientFilesForAgent } from '@/runtime/files/imports/agent-file-staging'
import { createUploadProgressPanel } from '@/components/transfer-progress/upload-progress-panel'
import type { NativeDropFlowArgs } from './terminal-drop-paste'
import { pasteResolvedDropPaths } from './terminal-drop-paste'
import { describeDropWorkspaceIfInactive } from './terminal-drop-workspace-label'
import { reportTerminalDropUploadSkipsAndFailures } from './terminal-drop-upload-report'
import { getTerminalTargetShellForWorktreePath } from './terminal-drop-shell'
import { terminalFileDropErrorMessage } from './terminal-native-file-drop-error'

export async function uploadRuntimeDropPaths(
  args: NativeDropFlowArgs & {
    runtimeEnvironmentId: string
    worktreeId: string
  }
): Promise<void> {
  const targetShell = getTerminalTargetShellForWorktreePath(args.worktreePath)
  const panel = createUploadProgressPanel({ worktreeId: args.worktreeId })
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
      args.assertCurrent,
      panel.progress
    )
    await pasteResolvedDropPaths({
      ...args,
      paths: staged.map(({ hostPath }) => hostPath),
      targetShell
    })
    reportTerminalDropUploadSkipsAndFailures(
      skipped,
      failed,
      describeDropWorkspaceIfInactive(args.worktreeId, args.worktreePath)
    )
  } catch (err) {
    // Why: only the error path tears the panel down immediately. On success it
    // owns its own exit, holding long enough to show how the drop ended.
    panel.close()
    toast.error(terminalFileDropErrorMessage(err, 'upload'), {
      description: describeDropWorkspaceIfInactive(args.worktreeId, args.worktreePath)
    })
  }
}
