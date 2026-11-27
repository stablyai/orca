import type { StructuredAgentSessionCreateParams } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import { structuredAgentSessionCreateFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { nativeChatUnsendableMessageBody } from '@/components/native-chat/attachments/native-chat-browser-file-references'

/** A create's first message the outbound policy refuses: no blocks, or one naming a browser file. */
export function structuredLaunchFirstMessageUnsendable(
  params: Pick<StructuredAgentSessionCreateParams, 'firstMessage'>
): boolean {
  return !!params.firstMessage && nativeChatUnsendableMessageBody(params.firstMessage.body) !== null
}

/**
 * A retained opening retried as a new create operation. There is no earlier operation to correlate
 * with, so a first message the policy refuses (an earlier build's) is not reissued: the chat is created
 * empty, with its digest recomputed, and that message stays as its own unconfirmed send, whose retry
 * meets the send gate. A sendable first message is reissued unchanged.
 */
export function retainedOpeningCreateParams(
  sessionId: string,
  params: StructuredAgentSessionCreateParams,
  clientOperationId: string
): StructuredAgentSessionCreateParams {
  if (!structuredLaunchFirstMessageUnsendable(params)) {
    return { ...params, envelope: { ...params.envelope, clientOperationId } }
  }
  const { firstMessage: _refused, ...empty } = params
  return {
    ...empty,
    envelope: {
      ...empty.envelope,
      clientOperationId,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({ sessionId, ...empty })
    }
  }
}
