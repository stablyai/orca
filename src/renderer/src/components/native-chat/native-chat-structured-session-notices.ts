import { nativeChatAntigravitySignInContent } from './native-chat-antigravity-settings'
import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { agentSessionRefusalCauseParts } from '../../../../shared/agent-session/failures/agent-session-refusal-notice'
import type { StructuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import type { AgentSessionRefusalReference } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { joinSentences } from '../../../../shared/sentence-joining'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import {
  isNativeChatSignInFailureKind,
  nativeChatSignInLabel,
  type NativeChatSignIn
} from './native-chat-sign-in'
import type {
  NativeChatComposerNotice,
  NativeChatComposerNoticeContent
} from './native-chat-composer-notice'

function nativeChatLaunchNotice({
  lifecycle,
  failure = null,
  agentLabel,
  onRetry,
  signIn = null
}: {
  lifecycle: StructuredAgentSessionLaunchLifecycle | null
  failure?: StructuredLaunchFailure | null
  agentLabel?: string
  onRetry: () => void
  /** Replace Retry with sign-in until authentication succeeds. */
  signIn?: NativeChatSignIn | null
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
  const cause = failure
    ? (failure.causeText ??
      agentSessionWriteNoticeText(
        agentSessionRefusalCauseParts(failure, agentLabel ? { agentName: agentLabel } : {})
      ))
    : ''
  // An argument problem already says the start failed; the generic lead would repeat it.
  const saysStartFailure =
    failure?.code === 'agent_session_operation_invalid' && failure.details?.argumentProblem
  const details = failure?.details
  const signInContent = nativeChatAntigravitySignInContent(
    details?.reason,
    agentLabel,
    details && 'account' in details ? details.account : undefined
  )
  return {
    content: signInContent,
    key: 'launch',
    kind: 'error',
    text: cause ? (saysStartFailure ? cause : joinSentences([message, cause])) : message,
    action:
      signIn && isNativeChatSignInFailureKind(failure?.details?.reason, signIn)
        ? {
            label: nativeChatSignInLabel(signIn),
            primary: true,
            onClick: signIn.signIn,
            disabled: signIn.signingIn
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
  readRefusal,
  composerError,
  signIn = null,
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
  readRefusal?: AgentSessionRefusalReference
  composerError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
  signIn?: NativeChatSignIn | null
  availability?: NativeChatComposerNotice | null
  hostPermission?: NativeChatComposerNotice | null
}): NativeChatComposerNotice[] {
  // A host held for its permission mode already says why nothing starts; Retry returns with it.
  const launchNotice = nativeChatLaunchNotice({
    lifecycle: hostPermission ? null : launch.lifecycle,
    failure: launch.failure,
    agentLabel,
    onRetry: launch.retry,
    signIn
  })
  // A missing history cannot replace the creation owner's available recovery.
  const sessionNotice =
    sessionError &&
    !(
      launch.lifecycle === 'visibility-unknown' &&
      launchNotice?.action &&
      readRefusal?.code === 'agent_session_identity_required' &&
      readRefusal.details?.reason === 'recordMissing'
    )
      ? {
          key: 'session',
          kind: 'error' as const,
          text: sessionError,
          ...(launchNotice ? { action: launchNotice.action } : {})
        }
      : null
  return [
    ...(hostPermission ? [hostPermission] : []),
    ...(availability ? [availability] : []),
    ...(launchNotice && !sessionNotice ? [launchNotice] : []),
    ...(sessionNotice ? [sessionNotice] : []),
    ...(composerError ? [{ key: 'composer-error', kind: 'error' as const, ...composerError }] : [])
  ]
}
