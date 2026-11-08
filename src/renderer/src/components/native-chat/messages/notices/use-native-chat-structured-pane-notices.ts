import { useNativeChatSignIn } from '../../host-access/native-chat-sign-in'
import { useNativeChatAvailabilityNotice } from './use-native-chat-availability-notice'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
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
  hostNotice
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
  hostNotice: NativeChatComposerNotice | null
}) {
  const t = useTranslate()
  const launch = { ...provisionalLaunch, retry: submits.retryLaunch }
  const signIn = useNativeChatSignIn({
    ...props,
    worktreeId: ownerWorktreeId,
    failure: provisionalLaunch.failure,
    startFailures
  })
  const availability = useNativeChatAvailabilityNotice({
    unavailable: controller.unavailable,
    signIn: props.agent === 'claude' ? null : signIn,
    agent: props.agent,
    wslDistro: continuation.view.wslDistro,
    launchFailure: provisionalLaunch.lifecycle === 'failed' ? provisionalLaunch.failure : null,
    journalItems: controller.journalItems,
    submissions: controller.submissions,
    deliveryNotices
  })
  // While Install shows, it says what to do; a start failure's "send again" or Retry can't help.
  const notices = structuredSessionNotices(
    {
      launch: install.slot.kind === 'install' ? { ...launch, lifecycle: null } : launch,
      agentLabel,
      // Said once: on the pane when the failure took it, else in the composer's notices.
      sessionError:
        viewState.kind === 'error' || !readFailure ? controller.error : readFailure.text,
      readRefusal: viewState.kind !== 'error' && readFailure ? controller.readRefusal : undefined,
      composerError: composerError ?? continuation.continueError,
      signIn,
      availability,
      hostPermission: hostSendGate.notice
    },
    t
  )
  if (hostNotice) {
    notices.push(hostNotice)
  }
  return { signIn, notices }
}
