import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageDeleteResult
} from '../../../../shared/agent-session-wire'
import { queuedMessageEditableText } from '../../../../shared/queued-message-edit'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import { returnMessageToComposer } from './structured-agent-session-message-hand-back'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'
import type { QueuedEditTransport } from './use-structured-agent-session-queued-edit'

/** Copy into the captured chat's durable draft before withdrawing the captured host body. */
export async function extractQueuedMessageToComposer(
  transport: QueuedEditTransport,
  scope: string | undefined,
  message: AgentSessionQueuedMessage | undefined
): Promise<void> {
  if (!scope || !message || queuedMessageEditableText(message.body) === null) {
    return
  }
  const { messageId, body } = message
  const fingerprint = agentSessionSendBodyFingerprint(transport.sessionId, body)
  let saved = false
  let committed: Promise<boolean> | undefined
  try {
    saved = returnMessageToComposer(
      scope,
      `queued-${messageId}-${fingerprint}-${structuredSessionOperationId()}`,
      body.blocks,
      undefined,
      {
        skills: body.skills,
        textPolicy: 'append-repeated',
        acknowledge: (result) => {
          committed = result
        }
      }
    )
  } catch {
    // The host copy remains the recovery source when local persistence refuses the addition.
  }
  if (!saved && committed) {
    saved = await committed
  }
  if (!saved) {
    toast.error(
      translate(
        'components.native-chat.queuedMessages.copyFailed',
        "Couldn't save this message in the chat box. It is still queued. Try Edit again."
      )
    )
    return
  }
  const result = await transport.write<AgentSessionQueuedMessageDeleteResult>(
    'agentSession.queuedMessageDelete',
    'agentSession.queuedMessageDelete',
    { messageId, expectedBodyFingerprint: fingerprint }
  )
  if (result.kind === 'not-done') {
    toast.error(
      translate(
        'components.native-chat.queuedMessages.copyRetained',
        '{{notice}} A copy is in the chat box.',
        { notice: result.notice }
      )
    )
  } else if (result.kind === 'done' && !result.value.deleted) {
    toast.error(
      translate(
        'components.native-chat.queuedMessages.copyAlreadyGone',
        'This message was already sent or removed. Its copy is in the chat box.'
      )
    )
  }
}
