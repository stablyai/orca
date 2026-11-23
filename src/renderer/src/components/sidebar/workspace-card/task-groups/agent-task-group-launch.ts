import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import { readNewAgentTabDefault } from '@/components/terminal/keyboard-shortcuts/terminal-agent-tab-shortcut'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  agentTaskGroupWorkspaceKey,
  canBrowseTaskGroupFolder
} from './agent-task-group-workspace-key'
import { fileChatInTaskGroupWhenSettled } from './agent-task-group-chat-filing'

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
    ...(args.folderPath
      ? canBrowseTaskGroupFolder(args.executionHostId)
        ? { chatLaunchDirectory: args.folderPath }
        : { initialCwd: args.folderPath }
      : {})
  })
  if (!outcome || 'refused' in outcome || !args.groupId) {
    return
  }
  const workspaceKey = agentTaskGroupWorkspaceKey(args.worktreeId, args.executionHostId)
  const { groupId } = args
  const assign = (tabId: string): void =>
    useAppStore.getState().assignTabToAgentTaskGroup(workspaceKey, tabId, groupId)
  if (outcome.surface.kind !== 'host-published') {
    assign(outcome.surface.tabId)
  }
  // A chat's row may be addressed by its session or by a tab the host publishes later.
  if (outcome.structuredSettlement) {
    fileChatInTaskGroupWhenSettled({
      settlement: outcome.structuredSettlement,
      worktreeId: args.worktreeId,
      assign
    })
  }
}
