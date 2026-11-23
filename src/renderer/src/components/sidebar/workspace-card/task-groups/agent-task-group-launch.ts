import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import { readNewAgentTabDefault } from '@/components/terminal/keyboard-shortcuts/terminal-agent-tab-shortcut'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { agentTaskGroupWorkspaceKey } from './agent-task-group-workspace-key'
import { fileLaunchInTaskGroup, taskGroupFolderLaunchArgs } from './agent-task-group-chat-filing'

/**
 * Starts the default agent in a new tab of the same workspace and files it under the group.
 * The tab shares the workspace's directory: no branch, worktree, or file copy is created.
 */
export async function launchConversationInAgentTaskGroup(args: {
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
  /** Absent: a standalone conversation in the workspace, outside every group. */
  groupId?: string
  /** The group's folder: a local chat runs there; a remote host's agent starts there in a terminal. */
  folderPath?: string
}): Promise<void> {
  const agent = readNewAgentTabDefault(useAppStore.getState(), args.worktreeId)
  if (!agent) {
    toast.message(
      translate(
        'auto.components.Terminal.5b2c1a9e44',
        'No agent CLI detected — install one or pick a default agent in Settings.'
      )
    )
    return
  }
  // The launch below is the first tab; without this an empty workspace also opened its default chat.
  await activateWorktreeFromSidebar(args.worktreeId, args.executionHostId, {
    providesInitialSurface: true
  })
  const outcome = launchAgentInNewTabWithOutcome({
    requestId: createNonSecureContextUuid(),
    agent,
    worktreeId: args.worktreeId,
    launchSource: 'sidebar',
    ...taskGroupFolderLaunchArgs(args.folderPath, args.executionHostId)
  })
  if (args.groupId) {
    fileLaunchInTaskGroup({
      outcome,
      worktreeId: args.worktreeId,
      workspaceKey: agentTaskGroupWorkspaceKey(args.worktreeId, args.executionHostId),
      groupId: args.groupId
    })
  }
}
