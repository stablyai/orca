import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  workspaceKindForWorktreeId,
  type ProspectiveWorkspace
} from '@/lib/agent-launch-route-input'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { useAppStore } from '@/store'

export type SourceControlLaunchAgentArgsApplicabilityInput = {
  agent: TuiAgent | null
  worktreeId?: string | null
  repoId?: string | null
  executionHostId?: ExecutionHostId
}

function prospectiveWorkspace(
  input: SourceControlLaunchAgentArgsApplicabilityInput
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

/**
 * Do CLI arguments reach the agent this launch would start?
 *
 * A structured native chat session drives the agent over a protocol and reads no CLI arguments,
 * so the dialog must not offer a field that launch would drop. Every other route — a TUI terminal,
 * or a terminal rendered as chat — is a real PTY that applies them.
 *
 * This resolves the route this specific launch would take rather than the user's default alone:
 * a chat-by-default user still gets a terminal on a remote host, an agent without a structured
 * session, or a floating workspace, and the arguments genuinely work there.
 */
export function sourceControlLaunchAppliesAgentArgs(
  input: SourceControlLaunchAgentArgsApplicabilityInput
): boolean {
  // Why: with no agent picked the route is undecidable; show the field rather than hide a
  // control the user may need, matching the pre-structured-chat behaviour.
  if (!input.agent) {
    return true
  }
  return (
    planAgentSessionLaunch(useAppStore.getState(), {
      agent: input.agent,
      workspace: prospectiveWorkspace(input)
    }).route !== 'structured-native-chat'
  )
}
