import type { AgentSessionAccountKind } from '../../../../../../shared/agent-session/failures/agent-session-availability'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import {
  readWslHostChatOfferForLaunch,
  useWslHostChatOfferSettingUp
} from '@/lib/agent-session/launch/structured-chat-wsl-host-offer'
import { useNativeChatHostSetup } from '../../host-access/native-chat-host-setup'
import {
  nativeChatAgySignedOutBeforeSend,
  nativeChatSignInAccount
} from '../../host-access/native-chat-sign-in-account'
import { useAntigravityChatAuthDetection } from '@/runtime/provider-accounts/sign-in/antigravity-chat-auth-detection'
import { isAntigravityGoogleMethod } from '@/components/provider-accounts/antigravity-chat-runtime-sign-in-policy'
import { useNativeChatAvailabilityNotice } from './use-native-chat-availability-notice'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
import { structuredAgentSessionHostPlace } from '../../pane/ownership/use-structured-agent-session-host-label'
import type { NativeChatStructuredViewProps } from '../../native-chat-view-types'
import type { useNativeChatProvisionalLaunch } from '../../host-access/use-native-chat-provisional-launch'
import type { useStructuredNativeChatSubmitReveal } from '../../pane/actions/use-structured-native-chat-submit-reveal'
import type { useStructuredAgentSession } from '../../session/structured/use-structured-agent-session'
import type { NativeChatInterruptedContinuation } from '../../usage/NativeChatInterruptedContinue'
import type { NativeChatViewState } from '../../session/status/native-chat-view-state'
import type { StructuredAgentSessionReadFailureNotice } from './structured-agent-session-read-failure-notice'
import type { useNativeChatInstallSlot } from '../../host-access/NativeChatInstallSlot'
import type { useNativeChatHostSendGate } from '../../host-access/use-native-chat-host-send-gate'
import type { NativeChatComposerNotice } from '../../composer/controls/native-chat-composer-notice'
import type { AgentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { useTranslate } from '../../../../i18n/use-translate'

export function useNativeChatStructuredPaneNotices({
  props,
  ownerWorktreeId,
  provisionalLaunch,
  submits,
  startFailures,
  controller,
  continuation,
  deliveryNotices,
  agentLabel,
  viewState,
  readFailure,
  composerError,
  install,
  hostSendGate,
  hostNotice,
  kickoffSignIn
}: {
  props: Omit<NativeChatStructuredViewProps, 'mode'>
  ownerWorktreeId: string | null
  provisionalLaunch: ReturnType<typeof useNativeChatProvisionalLaunch>
  submits: ReturnType<typeof useStructuredNativeChatSubmitReveal>
  startFailures: readonly AgentSessionFailureFact[]
  controller: ReturnType<typeof useStructuredAgentSession>
  continuation: NativeChatInterruptedContinuation
  deliveryNotices: Parameters<typeof useNativeChatAvailabilityNotice>[0]['deliveryNotices']
  agentLabel: string
  viewState: NativeChatViewState
  readFailure: StructuredAgentSessionReadFailureNotice | null
  composerError: Parameters<typeof structuredSessionNotices>[0]['composerError']
  install: ReturnType<typeof useNativeChatInstallSlot>
  hostSendGate: ReturnType<typeof useNativeChatHostSendGate>
  /** The account a new bot's refused kickoff needs signed in, which its setup card offers. */
  kickoffSignIn?: { account?: AgentSessionAccountKind } | null
  hostNotice: NativeChatComposerNotice | null
}) {
  const t = useTranslate()
  const launch = { ...provisionalLaunch, retry: submits.retryLaunch }
  const kickoffOwed = kickoffSignIn != null
  const details = provisionalLaunch.failure?.details
  const { demandModelCatalog } = controller.optionSurface
  const installing = install.slot.kind === 'install'
  // A listing read before Orca installed the agent said it was missing; read again once installed.
  const wasInstalling = useRef(installing)
  useEffect(() => {
    if (wasInstalling.current && !installing) {
      demandModelCatalog?.()
    }
    wasInstalling.current = installing
  }, [installing, demandModelCatalog])
  const launchFailed = provisionalLaunch.lifecycle === 'failed'
  const { retryLaunch } = submits
  // Stable so the setup context only changes with its own state, not every streamed token.
  const onRechecked = useCallback(() => {
    demandModelCatalog?.()
    if (launchFailed) {
      retryLaunch()
    }
  }, [demandModelCatalog, launchFailed, retryLaunch])
  // A Google-method Antigravity chat hears agy is signed out before its first send; advisory, as
  // the host's other verdicts: Send isn't held, since a login agy gets elsewhere isn't seen at once.
  const detection = useAntigravityChatAuthDetection(install.antigravityAuth?.host ?? null)
  const agySignedOut = isAntigravityGoogleMethod(detection?.method) && detection?.agySignedOut
  const unavailable =
    controller.unavailable ?? nativeChatAgySignedOutBeforeSend(agySignedOut, controller.submissions)
  const setup = useNativeChatHostSetup({
    ...props,
    worktreeId: ownerWorktreeId,
    // The host names which account is signed out; a managed-account sign-in can't fix the system one.
    account: nativeChatSignInAccount({
      unavailable,
      launchDetails: details,
      items: controller.journalItems,
      submissions: controller.submissions,
      kickoff: kickoffSignIn
    }),
    failure: provisionalLaunch.failure,
    startFailures,
    journalItems: controller.journalItems,
    onRechecked
  })
  const availability = useNativeChatAvailabilityNotice({
    // While Install or the sign-in strip shows, it already says what is missing and offers the fix.
    unavailable: installing || install.signIn ? null : unavailable,
    setup,
    agent: props.agent,
    wslDistro: continuation.view.wslDistro,
    launchFailure: provisionalLaunch.lifecycle === 'failed' ? provisionalLaunch.failure : null,
    journalItems: controller.journalItems,
    submissions: controller.submissions,
    deliveryNotices
  })
  const wslHostOffer = useAppStore(
    useShallow((s) => readWslHostChatOfferForLaunch(s, provisionalLaunch, ownerWorktreeId))
  )
  const wslHostOfferSettingUp = useWslHostChatOfferSettingUp(wslHostOffer?.distro)
  // While Install shows, it says what to do; a start failure's "send again" or Retry can't help.
  const notices = structuredSessionNotices(
    {
      launch: installing ? { ...launch, lifecycle: null } : launch,
      agentLabel,
      hostName: structuredAgentSessionHostPlace(
        continuation.view.remoteHost,
        continuation.view.hostLabel,
        t
      ),
      // Said once: on the pane when the failure took it, else in the composer's notices.
      sessionError:
        viewState.kind === 'error' || !readFailure ? controller.error : readFailure.text,
      readRefusal: viewState.kind !== 'error' && readFailure ? controller.readRefusal : undefined,
      composerError: composerError ?? continuation.continueError,
      setup,
      availability,
      hostPermission: hostSendGate.notice,
      wslHostOffer,
      wslHostOfferSettingUp
    },
    t
  )
  if (hostNotice) {
    notices.push(hostNotice)
  }
  // One Sign in on screen: while the composer's notice or Antigravity's sign-in strip has it,
  // transcript rows only say what wasn't sent.
  const signInInComposer =
    install.signIn !== null || notices.some((notice) => notice.signIn !== undefined)
  // A new bot's setup card offers the kickoff's sign-in, so the composer doesn't repeat it.
  const shown = kickoffOwed ? notices.filter((notice) => notice.signIn === undefined) : notices
  const rowSetup = useMemo(() => ({ ...setup, signInInComposer }), [setup, signInInComposer])
  return { setup: rowSetup, notices: shown }
}
