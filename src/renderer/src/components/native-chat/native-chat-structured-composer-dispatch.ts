import type { AgentJournalSkillRef } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionBlocksTooLarge } from '../../../../shared/rpc-contract/structured-agent-session-message-params'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS } from '../../../../shared/agent-session-refusal-notice'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { imageReferencesToPromptMarkers } from '../../../../shared/native-chat/transcript/native-chat-image-transcript-markers'
import type { StructuredAgentSessionCommandOutcome } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { StructuredAgentSessionSendRequest } from './structured-agent-session-send-slot'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  draftText: string,
  attachments: readonly NativeChatComposerImageAttachment[] = [],
  skills: readonly AgentJournalSkillRef[] = [],
  intent: Pick<StructuredAgentSessionSendRequest, 'alternate'> = {}
): Promise<Omit<StructuredAgentSessionCommandOutcome, 'handled'> & { revealsTranscript: boolean }> {
  // Number image chips by their attachment order in this message.
  const prompt = imageReferencesToPromptMarkers(
    draftText,
    attachments.map((attachment) => attachment.id)
  )
  const { handled, ...command } = await transport.dispatchCommand(prompt)
  // Commands already reveal at keypress; messages reveal unless admitted as queued cards.
  if (handled) {
    return { ...command, revealsTranscript: false }
  }
  // The composer still owns its draft until admission, so refusal must precede the handoff.
  const body = structuredAgentSessionSendBody(
    prompt,
    attachments.map(({ path }) => ({ path, previewUri: '' }))
  )
  if (structuredAgentSessionBlocksTooLarge(body.blocks)) {
    return {
      accepted: false,
      error: agentSessionWriteNoticeText([...AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS]),
      revealsTranscript: false
    }
  }
  const request = { ...(skills.length > 0 ? { skills } : {}), ...intent }
  const admission =
    Object.keys(request).length > 0
      ? transport.send(prompt, attachments, request)
      : transport.send(prompt, attachments)
  return { accepted: admission !== false, error: null, revealsTranscript: admission === true }
}
