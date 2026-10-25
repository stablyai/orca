import type { ExecutionHostId } from '../../../shared/execution-host'
import { activateStructuredAgentSessionTab } from './agent-session/structured-agent-session-tab-activation'
import { revealUnifiedTabPaletteTarget } from './unified-tab-palette-reveal'

export type AgentSessionTabPaletteActivationResult =
  | { status: 'activated' }
  | { status: 'blocked' }
  | { status: 'failed'; reason: 'missing-tab' | 'missing-worktree' }

export type AgentSessionTabPaletteActivationTarget = {
  executionHostId: ExecutionHostId
  tabId: string
  worktreeId: string
}

export function activateAgentSessionTabPaletteResult(
  target: AgentSessionTabPaletteActivationTarget
): AgentSessionTabPaletteActivationResult {
  const revealed = revealUnifiedTabPaletteTarget(target, 'agent-session')
  if (revealed.status !== 'revealed') {
    return revealed
  }
  // Why: this path also focuses the chat composer and tells the chat's host which tab is active.
  return activateStructuredAgentSessionTab({ worktreeId: target.worktreeId, tabId: target.tabId })
    ? { status: 'activated' }
    : { status: 'failed', reason: 'missing-tab' }
}
