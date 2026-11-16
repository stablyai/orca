import { useAppStore } from '@/store/index'
import { agentProviderSessionsEqual } from '../../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import type { AgentProviderSessionMetadata } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AppState } from '@/store/types'
import type { RefusedPaneResume } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'

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

/** Forget the host-retired conversation even in unmounted panes; newer observations survive. */
export function forgetRefusedPaneResume(
  state: AppState,
  paneKey: string,
  refused: RefusedPaneResume
): void {
  const expected = refused.expectedSavedRecord
  const savedKey = expected?.paneKey ?? paneKey
  const saved = state.sleepingAgentSessionsByPaneKey[savedKey]
  if (
    saved &&
    ((expected &&
      saved.capturedAt === expected.capturedAt &&
      saved.updatedAt === expected.updatedAt) ||
      // Main and window may capture the same accepted status at different times.
      (refused.expectedStatus && saved.updatedAt <= refused.expectedStatus.receivedAt)) &&
    namesRefusedResume(refused, saved)
  ) {
    state.clearSleepingAgentSession(savedKey)
  }
  const identity = refused.expectedStatus
  if (!identity) {
    return
  }
  useAppStore.getState().updateAgentStatusState((current, changedPaneKeys) => {
    const live = current.agentStatusByPaneKey.get(paneKey)
    if (
      !live ||
      live.updatedAt > identity.receivedAt ||
      live.stateStartedAt !== identity.stateStartedAt ||
      !namesRefusedResume(refused, { ...live, agent: live.agentType })
    ) {
      return current
    }
    const next = current.agentStatusByPaneKey.replace([[paneKey, null]])
    changedPaneKeys.add(paneKey)
    return { agentStatusByPaneKey: next }
  })
}
