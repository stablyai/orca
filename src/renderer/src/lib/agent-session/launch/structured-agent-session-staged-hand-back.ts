import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-hand-back'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import { agentSessionWriteNoticeText } from '@/components/native-chat/messages/notices/agent-session-write-notice-text'
import type {
  StructuredAgentSessionHandBackCustody,
  StructuredAgentSessionSendOutcome
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-send-runtime'
import type { StructuredPromptDeliveryResult } from './structured-agent-session-launch-callers'
import type {
  StagedDelivery,
  StagedStructuredLaunchPrompt
} from './structured-agent-session-staged-prompt'

// What one send operation of a staged launch prompt left, as the launch's public result.

/**
 * An unconfirmed send can still be recorded later. Every launch result carries that send operation's
 * own recorded signal, whichever path (reservation, create, plain send) reports it first.
 */
export function unconfirmedStructuredLaunchDelivery(
  outcome: StructuredAgentSessionSendOutcome,
  recorded: Promise<void> | undefined
): Pick<StructuredPromptDeliveryResult, 'unconfirmed' | 'whenRecorded'> {
  if (outcome !== 'unconfirmed') {
    return {}
  }
  return { unconfirmed: true, ...(recorded ? { whenRecorded: recorded } : {}) }
}

/**
 * The public result of one send operation of the prompt, by whichever path it went (reservation,
 * create, reserved send or plain send): the same mapping, from what that send itself heard.
 */
export function stagedSendDelivery(
  prompt: StagedStructuredLaunchPrompt,
  outcome: StructuredAgentSessionSendOutcome,
  handedBack: StructuredAgentSessionHandBackCustody | undefined,
  recorded: Promise<void> | undefined
): StagedDelivery {
  return {
    delivered: outcome === 'recorded',
    ...(outcome === 'returned'
      ? stagedHandBackDelivery(prompt, handedBack)
      : { inComposer: false }),
    ...unconfirmedStructuredLaunchDelivery(outcome, recorded)
  }
}

/**
 * What a hand-back left, as the launch's public result. `inComposer` claims the recipient's draft
 * durably holds the input, so a caller may retire its own copy: only a durable hand-back says so.
 * `handBackFinished` says the operation ended with the input in a draft (saved or not yet saved) or
 * kept by its caller, so no custody is left to wait for. A hand-back that threw (`lost`, or none
 * heard) says neither: the caller keeps its copy and a first send's lease keeps the originals until a
 * draft holds them.
 */
export function stagedHandBackDelivery(
  prompt: StagedStructuredLaunchPrompt,
  handedBack: StructuredAgentSessionHandBackCustody | undefined
): Pick<StagedDelivery, 'inComposer' | 'handBackFinished'> {
  const custody = prompt.callerKeepsText ? 'caller' : handedBack
  return {
    inComposer: custody === 'durable',
    ...(custody === 'durable' || custody === 'installed' || custody === 'caller'
      ? { handBackFinished: true as const }
      : {})
  }
}

/**
 * Return launch text to the composer unless the sender retains it, saying `notice` (why it came back)
 * when there is one. What it left: `durable` (journaled), `installed` (in the draft, its write not yet
 * saved), `lost` (putting it back threw: the notice then adds that it wasn't saved) or `caller`.
 */
export function handBackStagedLaunchPrompt(
  prompt: StagedStructuredLaunchPrompt,
  notice?: string
): StructuredAgentSessionHandBackCustody {
  if (prompt.callerKeepsText) {
    return 'caller'
  }
  let custody: StructuredAgentSessionHandBackCustody
  try {
    custody = handBackStructuredAgentSessionMessage(
      prompt.sessionId,
      `launch-${prompt.sessionId}`,
      structuredAgentSessionSendBody(prompt.text, prompt.attachments ?? [], prompt.skills)
    )
      ? 'durable'
      : 'installed'
  } catch (error) {
    console.error(
      '[native-chat-send] a launch message could not be put back in the composer',
      error
    )
    custody = 'lost'
  }
  if (notice || custody === 'lost') {
    publishStructuredAgentSessionSends(prompt.sessionId, {
      notice: agentSessionWriteNoticeText([
        ...(notice ? [{ text: notice }] : []),
        ...(custody === 'lost' ? (['messageNotSaved'] as const) : [])
      ])
    })
  }
  return custody
}
