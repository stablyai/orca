import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string,
  attachments: readonly NativeChatComposerImageAttachment[] = []
): Promise<{ accepted: boolean; error: string | null; revealsTranscript: boolean }> {
  const command = await transport.dispatchCommand(text)
  // A command's reveal, if any, came at the press; a message reveals unless it waits as a queued card.
  if (command.handled) {
    return { accepted: command.accepted, error: command.error, revealsTranscript: false }
  }
  const admission = transport.send(text, attachments)
  return { accepted: admission !== false, error: null, revealsTranscript: admission === true }
}
