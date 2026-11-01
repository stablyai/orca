import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import type { AgentSessionSettledBodySource } from './agent-session-settled-body'
import type { AgentSessionSettledBodyReader } from './agent-session-settled-body-reader'

export type AgentSessionSettledBodyOwner = {
  reader: AgentSessionSettledBodyReader
  sessionId: string
  epoch: string | null
}
export function receiptSettledBodySource(
  owner: AgentSessionSettledBodyOwner | null,
  body: NativeChatResolvedPrompt
): AgentSessionSettledBodySource | null {
  return owner?.epoch && body.deferredBody
    ? {
        ...body.deferredBody.descriptor,
        sessionId: owner.sessionId,
        epoch: owner.epoch,
        itemId: body.deferredBody.itemId,
        revision: body.deferredBody.revision
      }
    : null
}
