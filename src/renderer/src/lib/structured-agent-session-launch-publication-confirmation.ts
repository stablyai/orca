import { recoverPublishedSessionReceipt } from './structured-agent-session-launch-recovery'
import { publishStructuredLaunchCreateOptions } from './structured-agent-session-launch-create-message'
import { trackLaunchSettlement } from './structured-agent-session-launch-outcome-tracking'
import { trackStructuredLaunchConfirmationDeadline } from './structured-agent-session-launch-prompt-outcome'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners
} from './structured-agent-session-launch-registry'

/** A tab proves the chat exists; its journal must also confirm the immutable opening message. */
export function confirmStructuredLaunchFirstMessagePublication(
  worktreeId: string,
  sessionId: string
): void {
  const state =
    getStructuredLaunchStateBySessionId(sessionId) ??
    restorePersistedStructuredLaunchState(worktreeId, sessionId)
  if (!state || state.callers.outcome === 'pending' || state.cancelled) {
    return
  }
  state.callers.outcome = 'pending'
  state.visibilityUnknown = false
  state.promise = recoverPublishedSessionReceipt(state)
    .then((receipt) => publishStructuredLaunchCreateOptions(state, receipt))
    .catch((error: unknown) => {
      state.visibilityUnknown = true
      throw error
    })
  trackLaunchSettlement(state, state.promise)
  trackStructuredLaunchConfirmationDeadline(state, state.promise)
  notifyStructuredLaunchListeners()
}
