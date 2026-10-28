import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RefusedPaneResume } from '../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'

/** Whether a saved claim names the refused conversation. Only local claims can: the host judged
 *  its own chats, and a remote host's same id is a different conversation. */
export function namesRefusedResume(
  refused: RefusedPaneResume,
  claim: {
    agent?: string
    providerSession?: AgentProviderSessionMetadata
    connectionId?: string | null
  }
): boolean {
  return (
    !claim.connectionId &&
    claim.agent === refused.agent &&
    agentProviderSessionsEqual(refused.agent, claim.providerSession, refused.providerSession)
  )
}

/**
 * Main refused `paneKey`'s saved resume because a native chat owns that conversation. Forgets it as
 * this pane's, whether or not the pane is mounted, so nothing offers or retries it here. Another
 * pane holding the same conversation is refused and forgotten at its own restore. Main already
 * forgot its own copy, so nothing is sent back.
 */
export function forgetRefusedPaneResume(
  state: AppState,
  paneKey: string,
  refused: RefusedPaneResume
): void {
  const expected = refused.expectedSavedRecord
  const saved = expected && state.sleepingAgentSessionsByPaneKey[expected.paneKey]
  if (
    expected &&
    saved &&
    saved.capturedAt === expected.capturedAt &&
    saved.updatedAt === expected.updatedAt &&
    namesRefusedResume(refused, saved)
  ) {
    state.clearSleepingAgentSession(expected.paneKey)
  }
  const identity = refused.expectedStatus
  if (!identity) {
    return
  }
  useAppStore.setState((current) => {
    const live = current.agentStatusByPaneKey[paneKey]
    if (
      !live ||
      live.updatedAt > identity.receivedAt ||
      live.stateStartedAt !== identity.stateStartedAt ||
      !namesRefusedResume(refused, { ...live, agent: live.agentType })
    ) {
      return current
    }
    const next = { ...current.agentStatusByPaneKey }
    delete next[paneKey]
    return { agentStatusByPaneKey: next }
  })
}
