import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

/** `beforeSend` runs only when the text goes out as a message, right before the transport takes it. */
export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string,
  attachments: readonly NativeChatComposerImageAttachment[] = [],
  beforeSend?: () => void
): Promise<{ accepted: boolean; error: string | null }> {
  const command = await transport.dispatchCommand(text)
  if (command.handled) {
    return { accepted: command.accepted, error: command.error }
  }
  beforeSend?.()
  return { accepted: transport.send(text, attachments), error: null }
}
