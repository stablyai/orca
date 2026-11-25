import {
  nativeChatNotSignedInSentence,
  nativeChatSignInHostWords,
  nativeChatSignInNoticeView
} from '../../host-access/native-chat-sign-in-notice'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { agentSessionRefusalCauseParts } from '../../../../../../shared/agent-session/failures/agent-session-refusal-notice'
import type { StructuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import {
  wslHostChatOfferAction,
  wslHostChatOfferText,
  type WslHostChatOffer
} from '@/lib/agent-session/launch/structured-chat-wsl-host-offer'
import type { AgentSessionRefusalReference } from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionRefusalNamesTooOldCli } from '../../../../../../shared/agent-session/failures/agent-session-write-failure'
import { joinSentences } from '../../../../../../shared/text/sentence-joining'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import {
  isNativeChatSignInFailureKind,
  nativeChatSetupAction,
  type NativeChatHostSetup
} from '../../host-access/native-chat-host-setup-view'
import { nativeChatCliUpdateAction } from '../../host-access/native-chat-cli-update'
import type {
  NativeChatComposerNotice,
  NativeChatComposerNoticeContent
} from '../../composer/controls/native-chat-composer-notice'

function nativeChatLaunchNotice(
  {
    lifecycle,
    failure = null,
    agentLabel,
    hostName,
    onRetry,
    setup = null,
    wslHostOffer = null,
    wslHostOfferSettingUp = false
  }: {
    lifecycle: StructuredAgentSessionLaunchLifecycle | null
    failure?: StructuredLaunchFailure | null
    agentLabel?: string
    /** Where the chat runs, as a sentence names it. */
    hostName?: string
    onRetry: () => void
    /** Replace Retry with the host setup step (sign in, install) that fixes the failure. */
    setup?: NativeChatHostSetup | null
    /** A WSL folder's chat runs on its distro's host; Retry here would only refuse again. */
    wslHostOffer?: WslHostChatOffer | null
    wslHostOfferSettingUp?: boolean
  },
  t: Translate = translate
): NativeChatComposerNotice | null {
  if (lifecycle !== 'failed' && lifecycle !== 'visibility-unknown') {
    return null
  }
  const message =
    lifecycle === 'failed'
      ? t('auto.components.native.chat.NativeChatLaunchRetry.failed', 'Chat could not be started.')
      : t(
          'auto.components.native.chat.NativeChatLaunchRetry.unknown',
          'Chat connection could not be confirmed.'
        )
  if (lifecycle === 'failed' && wslHostOffer) {
    return {
      key: 'launch',
      kind: 'error',
      text: joinSentences([message, wslHostChatOfferText(t)]),
      action: wslHostChatOfferAction(wslHostOffer, t, wslHostOfferSettingUp)
    }
  }
  // No retry continues a conversation saved in another folder.
  const retryable = !(
    failure?.code === 'agent_session_identity_required' && failure.details?.otherFolder
  )
  const retry = retryable
    ? {
        label: t('auto.components.native.chat.NativeChatLaunchRetry.retry', 'Retry'),
        onClick: onRetry
      }
    : undefined
  const details = failure?.details
  const signedIn =
    isNativeChatSignInFailureKind(details?.reason, setup?.signIn) &&
    (setup?.resolved || setup?.signIn?.signedIn)
  const signIn = nativeChatSignInNoticeView(
    {
      kind: details?.reason,
      agent: agentLabel,
      account: details && 'account' in details ? details.account : undefined,
      setup
    },
    t
  )
  if (signIn?.button && !signedIn) {
    // The host words the failure, with any provider diagnostic; keep what the short line leaves out.
    const signInDetails = nativeChatSignInHostWords(
      failure?.causeText,
      {
        kind: 'notSignedIn',
        ...(details && 'account' in details && details.account ? { account: details.account } : {})
      },
      agentLabel
    )
    return {
      key: 'launch',
      kind: 'error',
      text: nativeChatNotSignedInSentence(
        agentLabel ?? sayAgentSessionFailureTranslated('theAgent'),
        t
      ),
      signIn,
      // The user may have signed in where nothing could confirm it; starting again stays theirs.
      ...(setup?.signIn?.unconfirmed && retry ? { action: retry } : {}),
      ...(signInDetails ? { signInDetails } : {})
    }
  }
  const cause =
    failure && !signedIn
      ? (failure.causeText ??
        agentSessionWriteNoticeText(
          agentSessionRefusalCauseParts(failure, {
            ...(agentLabel ? { agentName: agentLabel } : {}),
            ...(hostName ? { hostName } : {})
          })
        ))
      : ''
  const cliTooOld = agentSessionRefusalNamesTooOldCli(failure ?? undefined)
  // An argument problem already says the start failed; a too-old CLI says what chats need.
  const saysStartFailure =
    cliTooOld ||
    (failure?.code === 'agent_session_operation_invalid' && failure.details?.argumentProblem)
  return {
    key: 'launch',
    kind: 'error',
    text: cause ? (saysStartFailure ? cause : joinSentences([message, cause])) : message,
    action:
      nativeChatSetupAction(failure?.details?.reason, setup, t) ??
      nativeChatCliUpdateAction(cliTooOld, setup, t) ??
      retry
  }
}

export function structuredSessionNotices(
  {
    launch,
    agentLabel,
    hostName,
    sessionError,
    readRefusal,
    composerError,
    setup = null,
    availability = null,
    hostPermission = null,
    wslHostOffer = null,
    wslHostOfferSettingUp = false
  }: {
    launch: {
      lifecycle: StructuredAgentSessionLaunchLifecycle | null
      failure: StructuredLaunchFailure | null
      retry: () => void
    }
    agentLabel: string
    hostName?: string
    sessionError: string | null
    readRefusal?: AgentSessionRefusalReference
    composerError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
    setup?: NativeChatHostSetup | null
    availability?: NativeChatComposerNotice | null
    hostPermission?: NativeChatComposerNotice | null
    wslHostOffer?: WslHostChatOffer | null
    /** This distro's host is being set up, so its button shows busy. */
    wslHostOfferSettingUp?: boolean
  },
  t?: Translate
): NativeChatComposerNotice[] {
  // A host held for its permission mode already says why nothing starts; Retry returns with it.
  const launchNotice = nativeChatLaunchNotice(
    {
      lifecycle: hostPermission ? null : launch.lifecycle,
      failure: launch.failure,
      agentLabel,
      hostName,
      onRetry: launch.retry,
      setup,
      wslHostOffer,
      wslHostOfferSettingUp
    },
    t
  )
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
          ...(launchNotice && !launchNotice.signIn ? { action: launchNotice.action } : {})
        }
      : null
  return [
    ...(hostPermission ? [hostPermission] : []),
    ...(availability ? [availability] : []),
    // Sign in keeps its own row: its "Signed in" would otherwise read over an unrelated error.
    ...(launchNotice && (!sessionNotice || launchNotice.signIn) ? [launchNotice] : []),
    ...(sessionNotice ? [sessionNotice] : []),
    ...(composerError ? [{ key: 'composer-error', kind: 'error' as const, ...composerError }] : [])
  ]
}
