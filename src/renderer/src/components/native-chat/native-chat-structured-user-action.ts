import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { reportStructuredSessionUserInput } from '@/lib/worker-terminal-takeover-report'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

// User admission owns takeover and reveal; draft consumption belongs only to draft submission.
export function completeNativeChatStructuredUserAction(
  agent: AgentType,
  transport: NativeChatStructuredComposerTransport,
  revealsTranscript: boolean
): void {
  emitNativeChatMessageSent({ agent, runtime: transport.runtime })
  if (revealsTranscript) {
    transport.onSubmitted?.()
  }
  reportStructuredSessionUserInput(transport.sessionId, transport.runtimeEnvironmentId)
}
