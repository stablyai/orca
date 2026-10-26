import { nativeChatAntigravitySignInContent } from './native-chat-antigravity-settings'
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

function nativeChatLaunchNotice({
  lifecycle,
  failure = null,
  agentLabel,
  onRetry,
  claudeSignIn = null
}: {
  lifecycle: StructuredAgentSessionLaunchLifecycle | null
  failure?: StructuredLaunchFailure | null
  agentLabel?: string
  onRetry: () => void
  /** Replace Retry with sign-in until authentication succeeds. */
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
      ? (failure.causeText ??
        agentSessionWriteNoticeText(
          agentSessionRefusalCauseParts(failure, agentLabel ? { agentName: agentLabel } : {})
        ))
      : ''
  // An argument problem already says the start failed; the generic lead would repeat it.
  const saysStartFailure =
    failure?.code === 'agent_session_operation_invalid' && failure.details?.argumentProblem
  const signInContent = nativeChatAntigravitySignInContent(failure?.details?.reason, agentLabel)
  return {
    content: signInContent,
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
        : signInContent
          ? undefined
          : {
              label: translate('auto.components.native.chat.NativeChatLaunchRetry.retry', 'Retry'),
              onClick: onRetry
            }
  }
}

export function structuredSessionNotices({
  launch,
  agentLabel,
  sessionError,
  composerError,
  claudeSignIn = null,
  availability = null,
  hostPermission = null
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
  availability?: NativeChatComposerNotice | null
  hostPermission?: NativeChatComposerNotice | null
}): NativeChatComposerNotice[] {
  // A host held for its permission mode already says why nothing starts; Retry returns with it.
  const launchNotice = nativeChatLaunchNotice({
    lifecycle: hostPermission ? null : launch.lifecycle,
    failure: launch.failure,
    agentLabel,
    onRetry: launch.retry,
    claudeSignIn
  })
  return [
    ...(hostPermission ? [hostPermission] : []),
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
