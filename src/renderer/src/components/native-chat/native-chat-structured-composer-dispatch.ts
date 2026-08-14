import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { parseStructuredAgentSessionEditRequest } from '../../../../shared/structured-agent-session-composer'
import { translate } from '@/i18n/i18n'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string
): Promise<{ accepted: boolean; error: string | null }> {
  const editRequest = parseStructuredAgentSessionEditRequest(text)
  if (editRequest) {
    return {
      accepted: transport.send(editRequest, { effectAuthority: 'local_structured_write' }),
      error: null
    }
  }
  if (/^\/edit(?:\s|$)/i.test(text)) {
    return {
      accepted: false,
      error: translate(
        'components.native-chat.composer.editSourceChangeRequired',
        '/edit requires a source-change request.'
      )
    }
  }
  const command = await transport.dispatchCommand(text)
  if (command.handled) {
    return { accepted: command.accepted, error: command.error }
  }
  return { accepted: transport.send(text), error: null }
}
