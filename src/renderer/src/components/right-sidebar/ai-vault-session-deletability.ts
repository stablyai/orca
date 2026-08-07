import { isAiVaultDeletableAgent } from '../../../../shared/ai-vault-session-deletion'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { translate } from '@/i18n/i18n'
import { agentLabel } from './ai-vault-session-filters'
import {
  canUseLocalAiVaultSessionPathActions,
  isSyntheticAiVaultSessionPath
} from './ai-vault-session-path-actions'

// Matches the active-dot rule in ai-vault-session-row-display.
function isSessionLive(liveState: AgentStatusState | null | undefined): boolean {
  return liveState != null && liveState !== 'done'
}

/**
 * Why Delete is unavailable for this session, as the tooltip text to show — or
 * null when it is offered. Each message says which sessions are affected, never
 * why: a provider's storage layout is Orca's problem, not the reader's.
 *
 * NOT the security boundary — main re-validates the path on disk regardless.
 * The two sides agree on deletable-or-not but deliberately not on the order they
 * check, so an SSH session reads as "remote" rather than "unsupported agent".
 * What must hold is that renderer-deletable is a subset of main-deletable, and
 * it does: both consult the same shared agent set and host/synthetic predicates.
 */
export function aiVaultSessionDeleteBlockedReason(
  session: Pick<AiVaultSession, 'agent' | 'executionHostId' | 'filePath'>,
  liveState?: AgentStatusState | null
): string | null {
  if (!canUseLocalAiVaultSessionPathActions(session.executionHostId)) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonNonLocalHost',
      'Only sessions on this device can be deleted.'
    )
  }
  if (isSyntheticAiVaultSessionPath(session.filePath)) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonSyntheticPath',
      "This session can't be deleted from Orca."
    )
  }
  if (!isAiVaultDeletableAgent(session.agent)) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonUnsupportedAgent',
      "{{value0}} sessions can't be deleted from Orca.",
      { value0: agentLabel(session.agent) }
    )
  }
  // Last, so an otherwise-deletable session reads as "wait for it to finish"
  // rather than a permanent reason. Trashing a live transcript would drop the
  // writes the agent is still appending.
  if (isSessionLive(liveState)) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonSessionLive',
      'This session is still running — wait for it to finish before deleting.'
    )
  }
  return null
}
