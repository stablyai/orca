import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  workspaceKindForWorktreeId,
  type ProspectiveWorkspace
} from '@/lib/agent-launch-route-input'
import { resolveAgentSessionLaunchRoute } from '@/lib/agent-session-launch-plan'
import { useAppStore } from '@/store'

export type SourceControlLaunchAgentArgsApplicabilityInput = {
  agent: TuiAgent | null
  worktreeId?: string | null
  repoId?: string | null
  executionHostId?: ExecutionHostId
}

/** The workspace a source-control launch targets, which may not exist yet. */
export function sourceControlLaunchWorkspace(
  input: Omit<SourceControlLaunchAgentArgsApplicabilityInput, 'agent'>
): ProspectiveWorkspace {
  if (input.worktreeId) {
    return { kind: workspaceKindForWorktreeId(input.worktreeId), worktreeId: input.worktreeId }
  }
  return {
    kind: 'git-worktree',
    ...(input.repoId ? { repoId: input.repoId } : {}),
    ...(input.executionHostId ? { executionHostId: input.executionHostId } : {})
  }
}

/** Use the actual route: native chats ignore CLI args, while terminal/chat-rendered PTYs apply them even for chat-by-default users. */
export function sourceControlLaunchAppliesAgentArgs(
  input: SourceControlLaunchAgentArgsApplicabilityInput
): boolean {
  // Without an agent the route is unknown; keep the potentially needed field visible.
  if (!input.agent) {
    return true
  }
  return (
    resolveAgentSessionLaunchRoute(useAppStore.getState(), {
      agent: input.agent,
      workspace: sourceControlLaunchWorkspace(input)
    }) !== 'structured-native-chat'
  )
}
