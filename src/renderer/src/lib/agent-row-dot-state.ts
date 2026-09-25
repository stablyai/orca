import type { AgentDotState } from '@/components/AgentStateDot'
import type { AgentWorkingMode } from '../../../shared/agent-status-types'
import type { AgentRowState } from './agent-row-decay-state'

/**
 * Map an agent row's state onto the shared state-indicator vocabulary. One copy so the
 * sidebar card, the dashboard row and the notes send menu cannot drift on a new member.
 */
export function agentRowDotState(
  state: AgentRowState,
  workingMode?: AgentWorkingMode
): AgentDotState {
  switch (state) {
    case 'working':
      return workingMode === 'monitoring' ? 'monitoring' : 'working'
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
    case 'unverifiable':
      return state
  }
  return 'idle'
}

/**
 * Whether an unvisited row earns the unread badge. Why only settled states: a spinner or a
 * question glyph already demands attention, so a badge there is noise (mirrors the worktree slot).
 */
export function showsAgentRowUnreadBadge(state: AgentDotState): boolean {
  return state === 'done' || state === 'failed' || state === 'interrupted' || state === 'idle'
}
