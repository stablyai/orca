import type { AgentJournalSkillRef } from '../../../../shared/agent-session-journal-types'
import { imageReferencesToPromptMarkers } from '../../../../shared/native-chat-image-transcript-markers'
import type { StructuredAgentSessionCommandOutcome } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  draftText: string,
  attachments: readonly NativeChatComposerImageAttachment[] = [],
  skills: readonly AgentJournalSkillRef[] = []
): Promise<Omit<StructuredAgentSessionCommandOutcome, 'handled'> & { revealsTranscript: boolean }> {
  // The one place a chip's image gets its number: its place among the images this message carries.
  const prompt = imageReferencesToPromptMarkers(
    draftText,
    attachments.map((attachment) => attachment.id)
  )
  const { handled, ...command } = await transport.dispatchCommand(prompt)
  // A command's reveal, if any, came at the press; a message reveals unless it waits as a queued card.
  if (handled) {
    return { ...command, revealsTranscript: false }
  }
  const admission =
    skills.length > 0
      ? transport.send(prompt, attachments, { skills })
      : transport.send(prompt, attachments)
  return { accepted: admission !== false, error: null, revealsTranscript: admission === true }
}
