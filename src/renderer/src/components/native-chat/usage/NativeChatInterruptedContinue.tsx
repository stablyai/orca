import { useNativeChatUsageLimitAutoContinue } from '@/components/native-chat/usage/use-native-chat-usage-limit-auto-continue'
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

import { wslHostDistroForTarget } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import { useAppStore } from '@/store/index'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_SESSION_SEND_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-create-capabilities'
import { completeNativeChatStructuredUserAction } from '@/components/native-chat/composer/submit/native-chat-structured-user-action'
import {
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends,
  type StructuredAgentSessionPendingSend
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { latestNativeChatOrcaStopCut } from '../../../../../shared/native-chat/native-chat-orca-stop-cut'
import {
  latestNativeChatUsageLimitCut,
  NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE
} from '../../../../../shared/native-chat/native-chat-usage-limit-cut'
import { AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-continue-interrupted-capability'
import {
  failNativeChatInterruptedContinue,
  nativeChatInterruptedContinueState,
  NO_NATIVE_CHAT_INTERRUPTED_CONTINUE_ATTEMPT,
  nativeChatInterruptedContinueAccepted
} from '../../../../../shared/native-chat/native-chat-interrupted-continue'
import type { NativeChatOrcaStopView } from '@/components/native-chat/messages/notices/native-chat-orca-stop-context'
import { useStructuredAgentSessionHostLabel } from '@/components/native-chat/pane/ownership/use-structured-agent-session-host-label'
import { useNativeChatTargetRestartResuming } from '@/components/native-chat-restart-runtimes'
import { useNativeChatLaunchResumePending } from '@/components/native-chat-launch-resume-decision'
import type { NativeChatComposerNoticeContent } from '@/components/native-chat/composer/controls/native-chat-composer-notice'
import type { NativeChatStructuredComposerTransport } from '@/components/native-chat/composer/submit/native-chat-structured-composer-transport'

export type NativeChatInterruptedContinuation = {
  /** Host identity and continuation availability for the cut’s transcript row. */
  view: NativeChatOrcaStopView
  /** Show a failed Continue until retry, dismissal or continuation from any client. */
  continueError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
}

/** Offer continuation on the latest uncontinued stop cut; older hosts without this operation use ordinary sends. */
export function useNativeChatInterruptedContinuation(input: {
  target: RuntimeClientTarget
  agent: AgentType
  sessionId: string
  journalItems: readonly AgentJournalRenderItem[]
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
  /** Also true while the host may take no turn: Continue starts one. */
  isWorking: boolean
  /** Stable; a Continue click is the user's newer action, so it clears the composer's error. */
  reportComposerError: (text: null) => void
  /** Returns keyboard focus when the admitted control leaves the transcript. */
  focusComposer: () => void
  /** The composer's send; false when the chat took nothing. */
  transport: NativeChatStructuredComposerTransport
  pending: readonly Pick<StructuredAgentSessionPendingSend, 'phase'>[]
}): NativeChatInterruptedContinuation {
  const t = useTranslate()
  const { target, sessionId, reportComposerError, focusComposer, transport, agent } = input
  const latestTransport = useRef(transport)
  useLayoutEffect(() => {
    latestTransport.current = transport
  }, [transport])
  const hostLabel = useStructuredAgentSessionHostLabel(target)
  const wslDistro = useAppStore((s) => wslHostDistroForTarget(target, s.runtimeEnvironments))
  const capability = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY
  )
  const usageCapability = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_SEND_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY
  )
  // Suppress continuation during local launch resume; paired servers own their own chats.
  const launchPending = useNativeChatLaunchResumePending() && target.kind === 'local'
  const resuming = useNativeChatTargetRestartResuming(target).includes(sessionId) || launchPending
  const cut = useMemo(
    () => latestNativeChatOrcaStopCut(input.journalItems, input.submissions),
    [input.journalItems, input.submissions]
  )
  // Any host: Continue past a usage limit is the person's own message, which every host takes.
  const usageLimitCut = useMemo(
    () => latestNativeChatUsageLimitCut(input.journalItems, input.submissions),
    [input.journalItems, input.submissions]
  )
  const usageLimitAutoContinue = useNativeChatUsageLimitAutoContinue(
    target,
    sessionId,
    usageLimitCut
  )
  const [attempt, setAttempt] = useState(NO_NATIVE_CHAT_INTERRUPTED_CONTINUE_ATTEMPT)
  const [usageFailure, setUsageFailure] = useState<string | null>(null)
  if (usageFailure !== null && input.pending.some((entry) => entry.phase === 'sending')) {
    setUsageFailure(null)
  }
  const {
    continueAvailable,
    offeredTurnItemId: offered,
    failed: failedHere
  } = nativeChatInterruptedContinueState({
    capability,
    cut,
    isWorking: input.isWorking,
    resuming,
    attempt
  })
  const usageLimitTurnItemId =
    usageLimitCut &&
    !input.isWorking &&
    !resuming &&
    !input.pending.some((entry) => entry.phase === 'sending') &&
    !transport.sendOut &&
    transport.sendBlockedReason === undefined
      ? usageLimitCut.turnItemId
      : null
  const continueUsageLimit = useCallback(
    (hadFocus = false): void => {
      if (
        usageLimitTurnItemId === null ||
        usageCapability === 'unknown' ||
        getStructuredAgentSessionPendingSends(sessionId).some((entry) => entry.phase === 'sending')
      ) {
        return
      }
      const turnItemId = usageLimitTurnItemId
      setUsageFailure(null)
      reportComposerError(null)
      // Keeping the draft must not keep the previous send's error.
      publishStructuredAgentSessionSends(sessionId, { notice: null })
      const transport = latestTransport.current
      const admission = transport.send(NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE, [], {
        callerKeepsText: true,
        ...(usageCapability === 'supported'
          ? { usageLimitContinuationOfTurnItemId: turnItemId }
          : {}),
        onSettled: (outcome) => {
          if (outcome === 'returned') {
            setUsageFailure(turnItemId)
          }
        }
      })
      if (admission === false) {
        setUsageFailure(turnItemId)
      } else {
        completeNativeChatStructuredUserAction(
          agent,
          transport,
          admission === true ? transport.onSubmitted : undefined
        )
        if (hadFocus) {
          focusComposer()
        }
      }
    },
    [usageLimitTurnItemId, usageCapability, sessionId, reportComposerError, focusComposer, agent]
  )
  const continueNow = useCallback((): void => {
    if (offered === null) {
      return
    }
    const turnItemId = offered
    setAttempt({ asked: turnItemId, failedOn: null })
    reportComposerError(null)
    void nativeChatInterruptedContinueAccepted(
      callStructuredAgentSession<{ outcome?: string }>(target, 'agentSession.continueInterrupted', {
        sessionId,
        turnItemId
      })
    ).then((accepted) => {
      if (!accepted) {
        setAttempt((current) => failNativeChatInterruptedContinue(current, turnItemId))
      }
    })
  }, [offered, target, sessionId, reportComposerError])
  const remoteHost = target.kind === 'environment'
  const view = useMemo(
    () => ({
      hostLabel,
      remoteHost,
      wslDistro,
      continueAvailable,
      offeredTurnItemId: offered,
      continueNow,
      usageLimitTurnItemId,
      usageLimitAutoContinue,
      onUsageLimitHandOffStarted:
        usageLimitAutoContinue?.kind === 'scheduled' ? usageLimitAutoContinue.cancel : undefined,
      usageLimitContinueDisabled: usageCapability === 'unknown',
      continueUsageLimit
    }),
    [
      hostLabel,
      remoteHost,
      wslDistro,
      continueAvailable,
      offered,
      continueNow,
      usageLimitTurnItemId,
      usageLimitAutoContinue,
      usageCapability,
      continueUsageLimit
    ]
  )
  const failedText = t(
    'components.native-chat.interruptedContinue.failed',
    "Couldn't continue this chat. Try again, or send a message."
  )
  const usageFailedHere = usageFailure !== null && usageFailure === usageLimitCut?.turnItemId
  return {
    view,
    continueError: usageFailedHere
      ? { text: failedText, onDismiss: () => setUsageFailure(null) }
      : failedHere
        ? {
            text: failedText,
            onDismiss: () => setAttempt((current) => ({ ...current, failedOn: null }))
          }
        : null
  }
}

export function NativeChatInterruptedContinueButton({
  onContinue,
  disabled,
  label,
  explanation: shownExplanation
}: {
  onContinue: (hadFocus?: boolean) => void
  disabled?: boolean
  label?: string
  /** What Continue does here, when it is not picking up a reply Orca's stop cut off. */
  explanation?: string
}): React.JSX.Element {
  const t = useTranslate()
  const explanationId = useId()
  const explanation =
    shownExplanation ??
    t(
      'components.native-chat.interruptedContinue.explanation',
      'Continue, and the agent first checks whether its last step finished.'
    )
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="xs"
            aria-describedby={explanationId}
            onClick={(event) =>
              onContinue(event.currentTarget === event.currentTarget.ownerDocument.activeElement)
            }
            disabled={disabled}
          >
            <Play />
            {label ?? t('components.native-chat.interruptedContinue.continue', 'Continue')}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {explanation}
        </TooltipContent>
      </Tooltip>
      <span id={explanationId} className="sr-only">
        {explanation}
      </span>
    </>
  )
}
