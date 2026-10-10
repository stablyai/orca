import { useId, useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { latestNativeChatOrcaStopCut } from '../../../../shared/native-chat-orca-stop-cut'
import { AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-continue-interrupted-capability'
import type { NativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { useStructuredAgentSessionHostLabel } from './use-structured-agent-session-host-label'
import { useNativeChatRestartResuming } from '../native-chat-resume-on-restart-store'
import { useNativeChatLaunchResumePending } from '../native-chat-launch-resume-decision'
import type { NativeChatComposerNoticeContent } from './native-chat-composer-notice'

type ContinueAnswer = { outcome?: string }

export type NativeChatInterruptedContinuation = {
  /** Told to the chat's rows: the machine's name, whether it is remote, and if it can continue. */
  view: NativeChatOrcaStopView
  /** The cut turn Continue is offered on right now, if any. */
  offeredTurnItemId: string | null
  /** A Continue that did not go through, for the composer's notice card: shown while the chat
   *  still sits on that cut and gone once it is continued from anywhere. */
  continueError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
  continueNow: () => void
}

/**
 * Continue, while the chat's latest turn is a reply an Orca stop cut off and nothing was sent since.
 * Offered only by a host that has the operation; an older host writes no row naming the stop, so it
 * never has a cut to offer it on, and the user continues by sending a message.
 */
export function useNativeChatInterruptedContinuation(input: {
  target: RuntimeClientTarget
  sessionId: string
  journalItems: readonly AgentJournalRenderItem[]
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
  isWorking: boolean
  /** The composer's own error; a Continue click is the user's newer action, so it clears it. */
  composer: { clearError: () => void }
}): NativeChatInterruptedContinuation {
  const { target, sessionId } = input
  const hostLabel = useStructuredAgentSessionHostLabel(target)
  const capability = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY
  )
  // The restart prompt or the launch's own resume is carrying this chat on, or the launch may still
  // decide to; it resumes only this machine's chats.
  const launchPending = useNativeChatLaunchResumePending() && target.kind === 'local'
  const resuming = useNativeChatRestartResuming().includes(sessionId) || launchPending
  const cut = useMemo(
    () => latestNativeChatOrcaStopCut(input.journalItems, input.submissions),
    [input.journalItems, input.submissions]
  )
  // The cut this client already asked to continue: hidden until the journal shows what came of it.
  const [asked, setAsked] = useState<string | null>(null)
  const [failedOn, setFailedOn] = useState<string | null>(null)
  const offered =
    capability === 'supported' && cut && !input.isWorking && !resuming && asked !== cut.turnItemId
      ? cut.turnItemId
      : null
  const continueNow = (): void => {
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
    input.composer.clearError()
    void callStructuredAgentSession<ContinueAnswer>(target, 'agentSession.continueInterrupted', {
      sessionId,
      turnItemId
    }).then((answer) => (answer.outcome === 'refused' ? failed() : undefined), failed)
  }
  // Unknown counts as able: a host that writes cause rows has Continue, and the words stay put.
  const continueAvailable = capability !== 'unsupported'
  // One object per change, so the chat's rows re-render only when what they show changes.
  const remoteHost = target.kind === 'environment'
  const view = useMemo(
    () => ({ hostLabel, remoteHost, continueAvailable }),
    [hostLabel, remoteHost, continueAvailable]
  )
  const failedHere =
    failedOn !== null && cut?.turnItemId === failedOn
      ? translate(
          'components.native-chat.interruptedContinue.failed',
          "Couldn't continue this chat. Try again, or send a message."
        )
      : null
  return {
    view,
    offeredTurnItemId: offered,
    continueError: failedHere ? { text: failedHere, onDismiss: () => setFailedOn(null) } : null,
    continueNow
  }
}

export function NativeChatInterruptedContinue({
  continuation
}: {
  continuation: NativeChatInterruptedContinuation
}): React.JSX.Element | null {
  const explanationId = useId()
  if (continuation.offeredTurnItemId === null) {
    return null
  }
  const explanation = translate(
    'components.native-chat.interruptedContinue.explanation',
    'Continue, and the agent first checks whether its last step finished.'
  )
  return (
    <div className="mx-auto flex w-full max-w-4xl items-center justify-end px-4 py-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-describedby={explanationId}
            onClick={continuation.continueNow}
          >
            <Play className="size-3" />
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
    </div>
  )
}
