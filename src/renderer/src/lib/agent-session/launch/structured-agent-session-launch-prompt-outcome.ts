import { settleStructuredLaunchCreateOptions } from '../../structured-agent-session-launch-options'
import {
  StructuredAgentSessionCreateAbandonedError,
  StructuredAgentSessionCreateUnknownOutcomeError
} from '../../structured-agent-session-launch-errors'
import type { StructuredLaunchCaller } from '../../structured-agent-session-launch-callers'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import { STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS } from '@/components/native-chat/structured-agent-session-send-runtime'
import {
  notifyStructuredLaunchListeners,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

/** Completing the caller leaves uncertain opening content independent of live startup work. */
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
      outcome.delivered
    ) {
      return
    }
    if (!outcome.unconfirmed) {
      state.intent.beforeCreate = () => false
      group.outcome = 'failed'
      group.failedAt = Date.now()
    } else {
      if (state.intent.params.firstMessage) {
        state.operationEnded = true
        settleStructuredLaunchCreateOptions(state, { kind: 'unknown' })
      }
      state.visibilityUnknown = true
      group.outcome = 'unknown'
    }
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
export function boundedStructuredLaunchResult(
  state: StructuredLaunchState,
  caller: StructuredLaunchCaller
): Promise<StructuredAgentLaunchReceipt> {
  const prompt = caller.promptDeliveryResult
  if (!prompt) {
    if (state.visibilityUnknown && state.intent.params.firstMessage) {
      const completed = Promise.reject<StructuredAgentLaunchReceipt>(
        new StructuredAgentSessionCreateUnknownOutcomeError(
          'Opening message outcome unknown.',
          'agent_session_operation_unknown'
        )
      )
      void completed.catch(() => {})
      return completed
    }
    return state.promise
  }
  const bounded = Promise.race([
    state.promise,
    prompt.then((outcome) => {
      if (outcome.unconfirmed) {
        throw new StructuredAgentSessionCreateUnknownOutcomeError(
          'Opening message outcome unknown.',
          'agent_session_operation_unknown'
        )
      }
      if (!outcome.delivered) {
        throw new StructuredAgentSessionCreateAbandonedError('Opening input retired before create.')
      }
      return state.promise
    })
  ])
  void bounded.catch(() => {})
  return bounded
}
