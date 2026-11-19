import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { agentTurnEndedUncleanly } from '../../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import { lastInputBlocksHibernation } from './agent-hibernation-input-guard'

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
