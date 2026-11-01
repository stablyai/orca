import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

// User admission owns reveal; draft consumption belongs only to draft submission.
export function completeNativeChatStructuredUserAction(
  agent: AgentType,
  transport: NativeChatStructuredComposerTransport,
  revealsTranscript: boolean
): void {
  emitNativeChatMessageSent({ agent, runtime: transport.runtime })
  if (revealsTranscript) {
    transport.onSubmitted?.()
  }
}
