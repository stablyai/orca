import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

export function summary(
  overrides: Partial<AgentSessionStatusSummary> = {}
): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
    agent: 'codex',
    status: 'idle',
    latestPrompt: 'hello',
    updatedAt: 1,
    ...overrides
  }
}
