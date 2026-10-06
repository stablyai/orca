import { translate } from '@/i18n/i18n'
import type { ResumeFailure } from './native-chat-resume-on-restart-grouping'

/**
 * What the user can do about a chat Orca could not resume, decided from the host's reason.
 *
 * One sentence saying what to do and why, and the button that does it. Retry is the primary action
 * only where a second attempt can actually succeed — an ownership clash or a reconnect that never
 * happened. A refusal that stands (newer work in the chat, the provider saying no) sends the user to
 * the chat itself, because that is the only place it can be continued.
 */

export type ResumeFailureAction = 'open' | 'retry' | 'dismiss'

export type ResumeFailureGuidance = {
  text: string
  primary: ResumeFailureAction
  secondary: ResumeFailureAction | null
}

const RETRYABLE_OWNERSHIP = new Set([
  'agent_session_ownership_unknown',
  'execution_owner_reconciling'
])
const RETRYABLE_DELIVERY = new Set(['agent_session_not_attached', 'agent_session_send_failed'])
const NOT_RESUMABLE = new Set([
  'structured_agent_session_unsupported',
  'agent_session_identity_required'
])

/** Whether Resume may name this chat at all. The host already knows a retry would not run; an
 *  older host omits the flag and the row stays selectable. */
export function resumeFailureSelectable(failure: Pick<ResumeFailure, 'retryable'>): boolean {
  return failure.retryable !== false
}

export function resumeFailureGuidance(
  failure: Pick<ResumeFailure, 'outcome' | 'reason' | 'retryable'>
): ResumeFailureGuidance {
  const guidance = reasonGuidance(failure)
  // The host already knows a retry would not run, whatever the reason suggests.
  return !resumeFailureSelectable(failure) &&
    (guidance.primary === 'retry' || guidance.secondary === 'retry')
    ? { text: manualContinuationText(), primary: 'open', secondary: 'dismiss' }
    : guidance
}

function manualContinuationText(): string {
  return translate(
    'auto.components.NativeChatResumeFailureGuidance.fallback',
    'Orca couldn’t resume this chat. Open it to continue manually.'
  )
}

function reasonGuidance(failure: Pick<ResumeFailure, 'outcome' | 'reason'>): ResumeFailureGuidance {
  if (failure.outcome === 'unconfirmed') {
    return {
      text: translate(
        'auto.components.NativeChatResumeFailureGuidance.unconfirmed',
        'Orca couldn’t confirm the “continue” message was delivered. Open the chat and check before sending another.'
      ),
      primary: 'open',
      secondary: null
    }
  }
  const reason = failure.reason
  if (reason === 'agent_session_restart_work_superseded') {
    return {
      text: translate(
        'auto.components.NativeChatResumeFailureGuidance.superseded',
        'Open the chat and reply. New work arrived in it right after the restart, so Orca didn’t send its “continue” message.'
      ),
      primary: 'open',
      secondary: null
    }
  }
  if (reason === 'agent_session_conflict') {
    return {
      text: translate(
        'auto.components.NativeChatResumeFailureGuidance.conflict',
        'Another Orca window or terminal still owns this session. Close it, then retry.'
      ),
      primary: 'retry',
      secondary: 'open'
    }
  }
  if (RETRYABLE_OWNERSHIP.has(reason)) {
    return {
      text: translate(
        'auto.components.NativeChatResumeFailureGuidance.ownershipUnknown',
        'Orca is still working out which process owns this session. Wait a moment, then retry.'
      ),
      primary: 'retry',
      secondary: 'open'
    }
  }
  if (RETRYABLE_DELIVERY.has(reason)) {
    return {
      text: translate(
        'auto.components.NativeChatResumeFailureGuidance.notAttached',
        'The chat didn’t reconnect. Retry, or open it to start a fresh turn.'
      ),
      primary: 'retry',
      secondary: 'open'
    }
  }
  if (reason === 'agent_session_dispatch_rejected') {
    return {
      text: translate(
        'auto.components.NativeChatResumeFailureGuidance.dispatchRejected',
        'The agent refused the “continue” message. Open the chat and send one yourself.'
      ),
      primary: 'open',
      secondary: null
    }
  }
  if (NOT_RESUMABLE.has(reason)) {
    return {
      text: translate(
        'auto.components.NativeChatResumeFailureGuidance.unsupported',
        'This chat can’t be resumed by Orca. Open it to see where it stopped.'
      ),
      primary: 'open',
      secondary: 'dismiss'
    }
  }
  return { text: manualContinuationText(), primary: 'open', secondary: 'retry' }
}
