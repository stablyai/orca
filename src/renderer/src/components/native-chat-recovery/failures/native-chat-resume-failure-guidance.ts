import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'

/** Offer retry only for recoverable refusals; newer chat work or a standing provider refusal requires continuing in the chat.
 * Each text is a one-line reason beside the row's own action buttons, so it names the cause, not the fix. */

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

/** Respect host retryability; older hosts omit it and retain selectable rows. */
export function resumeFailureSelectable(failure: Pick<ResumeFailure, 'retryable'>): boolean {
  return failure.retryable !== false
}

export function resumeFailureGuidance(
  failure: Pick<ResumeFailure, 'outcome' | 'reason' | 'retryable'>,
  t?: Translate
): ResumeFailureGuidance {
  const guidance = reasonGuidance(failure, t)
  // The host already knows a retry would not run, whatever the reason suggests.
  return !resumeFailureSelectable(failure) &&
    (guidance.primary === 'retry' || guidance.secondary === 'retry')
    ? { text: manualContinuationText(t), primary: 'open', secondary: 'dismiss' }
    : guidance
}

function manualContinuationText(t: Translate = translate): string {
  return t('auto.components.NativeChatResumeFailureGuidance.fallbackShort', 'Couldn’t resume.')
}

function reasonGuidance(
  failure: Pick<ResumeFailure, 'outcome' | 'reason'>,
  t: Translate = translate
): ResumeFailureGuidance {
  if (failure.outcome === 'unconfirmed') {
    return {
      text: t(
        'auto.components.NativeChatResumeFailureGuidance.unconfirmedShort',
        'Couldn’t confirm it continued.'
      ),
      primary: 'open',
      secondary: null
    }
  }
  const reason = failure.reason
  if (reason === 'agent_session_restart_work_superseded') {
    return {
      text: t(
        'auto.components.NativeChatResumeFailureGuidance.supersededShort',
        'New work arrived after the restart.'
      ),
      primary: 'open',
      secondary: null
    }
  }
  if (reason === 'agent_session_conflict') {
    return {
      text: t(
        'auto.components.NativeChatResumeFailureGuidance.conflictShort',
        'Open in another window or terminal.'
      ),
      primary: 'retry',
      secondary: 'open'
    }
  }
  if (RETRYABLE_OWNERSHIP.has(reason)) {
    return {
      text: t(
        'auto.components.NativeChatResumeFailureGuidance.ownershipUnknownShort',
        'Not ready to resume yet.'
      ),
      primary: 'retry',
      secondary: 'open'
    }
  }
  if (RETRYABLE_DELIVERY.has(reason)) {
    return {
      text: t(
        'auto.components.NativeChatResumeFailureGuidance.notAttachedShort',
        'Didn’t reconnect.'
      ),
      primary: 'retry',
      secondary: 'open'
    }
  }
  if (reason === 'agent_session_dispatch_rejected') {
    return {
      text: t(
        'auto.components.NativeChatResumeFailureGuidance.dispatchRejectedShort',
        'The agent declined to continue.'
      ),
      primary: 'open',
      secondary: null
    }
  }
  if (NOT_RESUMABLE.has(reason)) {
    return {
      text: t(
        'auto.components.NativeChatResumeFailureGuidance.unsupportedShort',
        'Orca can’t resume this agent.'
      ),
      primary: 'open',
      secondary: 'dismiss'
    }
  }
  return { text: manualContinuationText(t), primary: 'open', secondary: 'retry' }
}
