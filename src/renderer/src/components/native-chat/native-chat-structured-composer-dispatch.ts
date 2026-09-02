import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string,
  attachments: readonly NativeChatComposerImageAttachment[] = []
): Promise<{ accepted: boolean; error: string | null }> {
  const command = await transport.dispatchCommand(text)
  if (command.handled) {
    return { accepted: command.accepted, error: command.error }
  }
  return { accepted: transport.send(text, attachments), error: null }
}
