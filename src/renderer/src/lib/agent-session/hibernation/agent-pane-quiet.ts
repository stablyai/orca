import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { agentTurnEndedUncleanly } from '../../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import { lastInputBlocksHibernation } from './agent-hibernation-input-guard'
import type { RuntimeTerminalAttention } from '../../../../../shared/terminal/runtime/runtime-terminal-contracts'

export type AgentPaneQuietEvidence = {
  inputAt: number | null
  inUse: boolean
  shownRemotely: boolean
}

// Why: provider done hooks can fire mid-Dispatch; only runtime-confirmed settlement makes sleep safe.
const hasUnsettledOrUnknownDispatch = ({ orchestration }: AgentStatusEntry): boolean =>
  orchestration
    ? !['completed', 'failed', 'circuit_broken'].includes(orchestration.dispatchStatus ?? '')
    : false

/** True when the agent's turn has settled and nothing (user, subagent, dispatch, remote client) is still using the pane. */
export function isAgentPaneQuiet(
  entry: AgentStatusEntry,
  evidence: AgentPaneQuietEvidence
): boolean {
  if (
    entry.state !== 'done' ||
    agentTurnEndedUncleanly(entry) ||
    Boolean(entry.subagents?.length) ||
    hasUnsettledOrUnknownDispatch(entry) ||
    evidence.inUse ||
    evidence.shownRemotely
  ) {
    return false
  }
  // Killing the PTY loses drafts/queued input typed during working too; input-after-done alone misses them.
  return evidence.inputAt === null || !lastInputBlocksHibernation(entry, evidence.inputAt)
}

/** Input from a paired client or phone reaches the host, not this window's own input stamps. */
export function getAgentPaneQuietEvidence(
  windowInputAt: number | undefined,
  attention: RuntimeTerminalAttention | undefined,
  inUse: boolean
): AgentPaneQuietEvidence {
  const inputAt = [windowInputAt, attention?.lastInputAt].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  )
  return {
    inputAt: inputAt.length > 0 ? Math.max(...inputAt) : null,
    inUse,
    shownRemotely: Boolean(attention?.shownRemotely)
  }
}
