import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'
import { agentSessionRefusalCauseParts } from '../../../../shared/agent-session-refusal-notice'
import type { StructuredLaunchFailure } from '@/lib/structured-agent-session-launch-failure'
import { joinSentences } from '../../../../shared/sentence-joining'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import {
  isClaudeSignInFailureKind,
  nativeChatClaudeSignInLabel,
  type NativeChatClaudeSignIn
} from './native-chat-claude-sign-in'
import type {
  NativeChatComposerNotice,
  NativeChatComposerNoticeContent
} from './native-chat-composer-notice'

/** A chat whose start failed or went unconfirmed, as a notice with Retry. */
function nativeChatLaunchNotice({
  lifecycle,
  failure = null,
  agentLabel,
  onRetry,
  claudeSignIn = null
}: {
  lifecycle: StructuredAgentSessionLaunchLifecycle | null
  failure?: StructuredLaunchFailure | null
  /** Names the agent in a start failure's words. */
  agentLabel?: string
  onRetry: () => void
  /** Offered instead of Retry until it signs in, when the start failed for want of a sign-in. */
  claudeSignIn?: NativeChatClaudeSignIn | null
}): NativeChatComposerNotice | null {
  if (lifecycle !== 'failed' && lifecycle !== 'visibility-unknown') {
    return null
  }
  const message =
    lifecycle === 'failed'
      ? translate(
          'auto.components.native.chat.NativeChatLaunchRetry.failed',
          'Chat could not be started.'
        )
      : translate(
          'auto.components.native.chat.NativeChatLaunchRetry.unknown',
          'Chat connection could not be confirmed.'
        )
  const cause =
    lifecycle === 'failed' && failure
      ? (failure.authStartupMessage ??
        agentSessionWriteNoticeText(
          agentSessionRefusalCauseParts(failure, agentLabel ? { agentName: agentLabel } : {})
        ))
      : ''
  // An argument problem already says the start failed; the generic lead would repeat it.
  const saysStartFailure =
    failure?.code === 'agent_session_operation_invalid' && failure.details?.argumentProblem
  return {
    key: 'launch',
    kind: 'error',
    text: cause ? (saysStartFailure ? cause : joinSentences([message, cause])) : message,
    action:
      claudeSignIn && isClaudeSignInFailureKind(failure?.details?.reason)
        ? {
            label: nativeChatClaudeSignInLabel(claudeSignIn),
            onClick: claudeSignIn.signIn,
            disabled: claudeSignIn.signingIn
          }
        : {
            label: translate('auto.components.native.chat.NativeChatLaunchRetry.retry', 'Retry'),
            onClick: onRetry
          }
  }
}

/** A structured chat's own notices, for the card above its composer. */
export function structuredSessionNotices({
  launch,
  agentLabel,
  sessionError,
  composerError,
  claudeSignIn = null,
  availability = null
}: {
  launch: {
    lifecycle: StructuredAgentSessionLaunchLifecycle | null
    failure: StructuredLaunchFailure | null
    retry: () => void
  }
  agentLabel: string
  sessionError: string | null
  composerError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
  claudeSignIn?: NativeChatClaudeSignIn | null
  /** Why the host says no chat can start here, from `useNativeChatAvailabilityNotice`. */
  availability?: NativeChatComposerNotice | null
}): NativeChatComposerNotice[] {
  const launchNotice = nativeChatLaunchNotice({
    lifecycle: launch.lifecycle,
    failure: launch.failure,
    agentLabel,
    onRetry: launch.retry,
    claudeSignIn
  })
  return [
    ...(availability ? [availability] : []),
    ...(launchNotice && !sessionError ? [launchNotice] : []),
    ...(sessionError
      ? [
          {
            key: 'session',
            kind: 'error' as const,
            text: sessionError,
            ...(launchNotice ? { action: launchNotice.action } : {})
          }
        ]
      : []),
    ...(composerError ? [{ key: 'composer-error', kind: 'error' as const, ...composerError }] : [])
  ]
}
