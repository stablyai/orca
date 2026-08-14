import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string
): Promise<{ accepted: boolean; error: string | null }> {
  const command = await transport.dispatchCommand(text)
  if (command.handled) {
    return { accepted: command.accepted, error: command.error }
  }
  return { accepted: transport.send(text), error: null }
}
