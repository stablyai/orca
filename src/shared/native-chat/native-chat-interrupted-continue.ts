// Continue an Orca-stopped turn: which cut is offered, and when a failed attempt still shows.

import type { StructuredAgentSessionHostCapabilityState } from '../agent-session/structured-agent-session-host-capability'
import type { NativeChatOrcaStopCut } from './native-chat-orca-stop-cut'

/** `asked`: the cut this client asked to continue, hidden until the journal shows what came of it. */
export type NativeChatInterruptedContinueAttempt = {
  asked: string | null
  failedOn: string | null
}

export const NO_NATIVE_CHAT_INTERRUPTED_CONTINUE_ATTEMPT: NativeChatInterruptedContinueAttempt = {
  asked: null,
  failedOn: null
}

export function nativeChatInterruptedContinueState(input: {
  capability: StructuredAgentSessionHostCapabilityState
  cut: NativeChatOrcaStopCut | null
  /** Also true while the host may take no turn: Continue starts one. */
  isWorking: boolean
  resuming: boolean
  attempt: NativeChatInterruptedContinueAttempt
}): {
  /** Unknown counts as able: a host that writes cause rows has Continue, and the words stay put. */
  continueAvailable: boolean
  offeredTurnItemId: string | null
  /** A failed Continue shows until retry, dismissal, or a newer request from any client. */
  failed: boolean
} {
  const { capability, cut, attempt } = input
  return {
    continueAvailable: capability !== 'unsupported',
    offeredTurnItemId:
      capability === 'supported' &&
      cut &&
      !input.isWorking &&
      !input.resuming &&
      attempt.asked !== cut.turnItemId
        ? cut.turnItemId
        : null,
    failed: attempt.failedOn !== null && cut?.turnItemId === attempt.failedOn
  }
}

/** Nothing was accepted: offer the cut again, with one failure line that a retry replaces. */
export function failNativeChatInterruptedContinue(
  attempt: NativeChatInterruptedContinueAttempt,
  turnItemId: string
): NativeChatInterruptedContinueAttempt {
  return { asked: attempt.asked === turnItemId ? null : attempt.asked, failedOn: turnItemId }
}

/** False when the host took nothing; the host rechecks the cut under the session lock. */
export function nativeChatInterruptedContinueAccepted(
  answer: Promise<{ outcome?: string }>
): Promise<boolean> {
  return answer.then(
    (settled) => settled.outcome !== 'refused',
    () => false
  )
}
