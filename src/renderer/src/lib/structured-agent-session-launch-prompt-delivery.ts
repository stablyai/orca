import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-send-mutation'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-hand-back'
import { sendStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from '@/components/native-chat/structured-agent-session-send-attempt'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { agentSessionWriteNoticeText } from '@/components/native-chat/agent-session-write-notice-text'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  StagedStructuredLaunchPrompt,
  StagedDelivery
} from './structured-agent-session-launch-prompt'

/** Puts a launch's text in its chat's composer, unless its sender keeps it. True when it did; a
 *  draft write that throws is reported in the chat instead, and never stops its caller. */
export function handBackStagedPrompt(prompt: StagedStructuredLaunchPrompt): boolean {
  if (prompt.callerKeepsText) {
    return false
  }
  try {
    handBackStructuredAgentSessionMessage(
      prompt.sessionId,
      `launch-${prompt.sessionId}`,
      structuredAgentSessionSendBody(prompt.text, [])
    )
    return true
  } catch (error) {
    console.error(
      '[native-chat-send] a launch message could not be put back in the composer',
      error
    )
    publishStructuredAgentSessionSends(prompt.sessionId, {
      notice: agentSessionWriteNoticeText(['messageNotSaved'])
    })
    return false
  }
}

export function sendStagedPrompt(
  prompt: StagedStructuredLaunchPrompt,
  receipt: StructuredAgentLaunchReceipt | null,
  target: RuntimeClientTarget,
  unstageStructuredLaunchPrompt: (prompt: StagedStructuredLaunchPrompt) => void
): Promise<StagedDelivery> {
  prompt.delivery ??= (async () => {
    if (receipt) {
      noteStructuredAgentSessionFence(prompt.sessionId, receipt.fence)
    }
    const sent = prompt.slot
      ? prompt.slot.send(target)
      : sendStructuredAgentSessionMessage({
          sessionId: prompt.sessionId,
          target,
          text: prompt.text
        })
    if (!sent) {
      // Another send of the chat holds its slot: the launch text waits in the composer instead.
      unstageStructuredLaunchPrompt(prompt)
      return { delivered: false, inComposer: handBackStagedPrompt(prompt), busy: true }
    }
    try {
      const outcome = await sent.outcome
      return {
        delivered: outcome === 'recorded',
        inComposer:
          !prompt.callerKeepsText && (outcome === 'returned' || outcome === 'unconfirmed'),
        ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
      }
    } finally {
      unstageStructuredLaunchPrompt(prompt)
    }
  })()
  return prompt.delivery
}
