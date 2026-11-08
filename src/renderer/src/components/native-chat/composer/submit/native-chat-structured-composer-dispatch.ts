import { agentSessionInteractionCommand } from '../../../../../../shared/agent-session/options/agent-session-interaction-mode'
import type { AgentJournalSkillRef } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionBlocksTooLarge } from '../../../../../../shared/rpc-contract/structured-agent-session-message-params'
import { structuredAgentSessionSendBody } from '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS } from '../../../../../../shared/agent-session/failures/agent-session-refusal-notice'
import { agentSessionWriteNoticeText } from '../../messages/notices/agent-session-write-notice-text'
import { imageReferencesToPromptMarkers } from '../../../../../../shared/native-chat/transcript/native-chat-image-transcript-markers'
import type { StructuredAgentSessionCommandOutcome } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import type { NativeChatComposerImageAttachment } from '../../attachments/chips/native-chat-image-attachment'
import type { StructuredAgentSessionSendRequest } from '../../session/structured/delivery/structured-agent-session-send-slot'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  draftText: string,
  attachments: readonly NativeChatComposerImageAttachment[] = [],
  skills: readonly AgentJournalSkillRef[] = [],
  request?: StructuredAgentSessionSendRequest,
  onPending?: () => void
): Promise<Omit<StructuredAgentSessionCommandOutcome, 'handled'> & { revealsTranscript: boolean }> {
  // Number image chips by their attachment order in this message.
  const prompt = imageReferencesToPromptMarkers(
    draftText,
    attachments.map((attachment) => attachment.id)
  )
  const pickedModeSkill =
    agentSessionInteractionCommand('codex', prompt) !== null &&
    skills.some((skill) => prompt.trimEnd() === `/${skill.name}`)
  const { handled, ...command } = pickedModeSkill
    ? { handled: false, accepted: false, error: null }
    : await transport.dispatchCommand(prompt)
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
  const sendRequest = skills.length > 0 ? { ...request, skills } : request
  const admission = sendRequest
    ? transport.send(prompt, attachments, sendRequest)
    : transport.send(prompt, attachments)
  if (admission instanceof Promise) {
    onPending?.()
  }
  const accepted = await admission
  return { accepted: accepted !== false, error: null, revealsTranscript: accepted === true }
}
