import type { StructuredLaunchCaller } from './structured-agent-session-launch-callers'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import { STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  notifyStructuredLaunchListeners,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

/** The message deadline frees the composer and offers the existing Retry while create is unknown. */
export function trackStructuredLaunchPromptOutcome(
  state: StructuredLaunchState,
  caller: StructuredLaunchCaller
): void {
  const group = state.callers
  void caller.promptDeliveryResult?.then((outcome) => {
    if (
      state.callers !== group ||
      state.cancelled ||
      group.outcome !== 'pending' ||
      !(outcome.inComposer || outcome.unconfirmed)
    ) {
      return
    }
    state.visibilityUnknown = true
    group.outcome = 'unknown'
    notifyStructuredLaunchListeners()
  })
}

/** Confirmation checks share the opening message deadline after its send slot has settled. */
export function trackStructuredLaunchConfirmationDeadline(
  state: StructuredLaunchState,
  promise: Promise<StructuredAgentLaunchReceipt>
): void {
  if (state.intent.createMessageSupport === false) {
    return
  }
  const deadline = setTimeout(() => {
    if (
      state.promise !== promise ||
      state.cancelled ||
      state.callers.outcome !== 'pending' ||
      state.intent.createMessageSupport === false
    ) {
      return
    }
    state.visibilityUnknown = true
    state.callers.outcome = 'unknown'
    notifyStructuredLaunchListeners()
  }, STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
  const clear = (): void => clearTimeout(deadline)
  void promise.then(clear, clear)
}
