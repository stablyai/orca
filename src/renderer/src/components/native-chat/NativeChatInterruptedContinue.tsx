import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import type { AgentType } from '../../../../shared/agent-status-types'
import { AGENT_SESSION_SEND_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { completeNativeChatStructuredUserAction } from './native-chat-structured-user-action'
import {
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { latestNativeChatOrcaStopCut } from '../../../../shared/native-chat/native-chat-orca-stop-cut'
import {
  latestNativeChatUsageLimitCut,
  NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE
} from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import { AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-continue-interrupted-capability'
import type { NativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { useStructuredAgentSessionHostLabel } from './use-structured-agent-session-host-label'
import { useNativeChatRestartResuming } from '../native-chat-resume-on-restart-store'
import { useNativeChatLaunchResumePending } from '../native-chat-launch-resume-decision'
import type { NativeChatComposerNoticeContent } from './native-chat-composer-notice'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

type ContinueAnswer = { outcome?: string }

export type NativeChatInterruptedContinuation = {
  /** Told to the chat's rows: the machine's name, whether it is remote, if it can continue, and the
   *  cut row that carries Continue. */
  view: NativeChatOrcaStopView
  /** A Continue that did not go through, for the composer's notice card: shown while the chat
   *  still sits on that cut and gone once it is continued from anywhere. */
  continueError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
}

/**
 * Continue, while the chat's latest turn is a reply an Orca stop cut off and nothing was sent since.
 * Offered only by a host that has the operation; an older host writes no row naming the stop, so it
 * never has a cut to offer it on, and the user continues by sending a message.
 */
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
  const { target, sessionId, reportComposerError, focusComposer, transport, agent } = input
  const latestTransport = useRef(transport)
  useLayoutEffect(() => {
    latestTransport.current = transport
  }, [transport])
  const hostLabel = useStructuredAgentSessionHostLabel(target)
  const capability = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY
  )
  const usageCapability = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_SEND_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY
  )
  // The restart prompt or the launch's own resume is carrying this chat on, or the launch may still
  // decide to; it resumes only this machine's chats.
  const launchPending = useNativeChatLaunchResumePending() && target.kind === 'local'
  const resuming = useNativeChatRestartResuming().includes(sessionId) || launchPending
  const cut = useMemo(
    () => latestNativeChatOrcaStopCut(input.journalItems, input.submissions),
    [input.journalItems, input.submissions]
  )
  // Any host: Continue past a usage limit is the person's own message, which every host takes.
  const usageLimitCut = useMemo(
    () => latestNativeChatUsageLimitCut(input.journalItems, input.submissions),
    [input.journalItems, input.submissions]
  )
  // The cut this client already asked to continue: hidden until the journal shows what came of it.
  const [asked, setAsked] = useState<string | null>(null)
  const [usageFailure, setUsageFailure] = useState<{
    turnItemId: string
    unconfirmed: boolean
  } | null>(null)
  const [failedOn, setFailedOn] = useState<string | null>(null)
  if (usageFailure !== null && input.pending.length > 0) {
    setUsageFailure(null)
  }
  const offered =
    capability === 'supported' && cut && !input.isWorking && !resuming && asked !== cut.turnItemId
      ? cut.turnItemId
      : null
  const usageLimitTurnItemId =
    usageLimitCut &&
    !input.isWorking &&
    !resuming &&
    input.pending.length === 0 &&
    !transport.sendOut &&
    transport.sendBlockedReason === undefined
      ? usageLimitCut.turnItemId
      : null
  const continueUsageLimit = useCallback(
    (hadFocus = false): void => {
      if (
        usageLimitTurnItemId === null ||
        usageCapability === 'unknown' ||
        getStructuredAgentSessionPendingSends(sessionId).length > 0
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
          if (outcome === 'returned' || outcome === 'unconfirmed') {
            setUsageFailure({ turnItemId, unconfirmed: outcome === 'unconfirmed' })
          }
        }
      })
      if (admission === false) {
        setUsageFailure({ turnItemId, unconfirmed: false })
      } else {
        completeNativeChatStructuredUserAction(agent, transport, admission === true)
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
    // Nothing was accepted: one line in the composer, which a retry replaces rather than repeats.
    const failed = (): void => {
      setAsked((current) => (current === turnItemId ? null : current))
      setFailedOn(turnItemId)
    }
    setAsked(turnItemId)
    setFailedOn(null)
    reportComposerError(null)
    void callStructuredAgentSession<ContinueAnswer>(target, 'agentSession.continueInterrupted', {
      sessionId,
      turnItemId
    }).then((answer) => (answer.outcome === 'refused' ? failed() : undefined), failed)
  }, [offered, target, sessionId, reportComposerError])
  // Unknown counts as able: a host that writes cause rows has Continue, and the words stay put.
  const continueAvailable = capability !== 'unsupported'
  // One object per change, so the chat's rows re-render only when what they show changes.
  const remoteHost = target.kind === 'environment'
  const view = useMemo(
    () => ({
      hostLabel,
      remoteHost,
      continueAvailable,
      offeredTurnItemId: offered,
      continueNow,
      usageLimitTurnItemId,
      usageLimitContinueDisabled: usageCapability === 'unknown',
      continueUsageLimit
    }),
    [
      hostLabel,
      remoteHost,
      continueAvailable,
      offered,
      continueNow,
      usageLimitTurnItemId,
      usageCapability,
      continueUsageLimit
    ]
  )
  const failedHere =
    failedOn !== null && cut?.turnItemId === failedOn
      ? translate(
          'components.native-chat.interruptedContinue.failed',
          "Couldn't continue this chat. Try again, or send a message."
        )
      : null
  const usageFailedHere =
    usageFailure?.turnItemId === usageLimitCut?.turnItemId && usageFailure
      ? usageFailure.unconfirmed
        ? translate(
            'components.native-chat.interruptedContinue.unconfirmed',
            "Couldn't confirm whether {{agent}} received Continue. Check the chat before trying again.",
            { agent: structuredAgentLabel(agent) }
          )
        : translate(
            'components.native-chat.interruptedContinue.failed',
            "Couldn't continue this chat. Try again, or send a message."
          )
      : null
  return {
    view,
    continueError: usageFailedHere
      ? { text: usageFailedHere, onDismiss: () => setUsageFailure(null) }
      : failedHere
        ? { text: failedHere, onDismiss: () => setFailedOn(null) }
        : null
  }
}

/** Continue, on the row that says Orca stopped this reply: the one action that picks it back up. */
export function NativeChatInterruptedContinueButton({
  onContinue,
  disabled,
  explanation: shownExplanation
}: {
  onContinue: (hadFocus?: boolean) => void
  disabled?: boolean
  /** What Continue does here, when it is not picking up a reply Orca's stop cut off. */
  explanation?: string
}): React.JSX.Element {
  const explanationId = useId()
  const explanation =
    shownExplanation ??
    translate(
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
            {translate('components.native-chat.interruptedContinue.continue', 'Continue')}
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
