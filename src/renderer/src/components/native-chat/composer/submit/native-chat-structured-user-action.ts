import { useAppStore } from '@/store/index'
import { emitNativeChatMessageSent } from '@/components/native-chat/telemetry/native-chat-telemetry'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'

export function captureNativeChatStructuredUserAction(
  transport: NativeChatStructuredComposerTransport
): () => void {
  return transport.tabId && transport.worktreeId
    ? useAppStore.getState().captureTabInteraction(transport.tabId, transport.worktreeId)
    : () => {}
}

// User admission owns reveal; draft consumption belongs only to draft submission.
export function completeNativeChatStructuredUserAction(
  agent: AgentType,
  transport: NativeChatStructuredComposerTransport,
  reveal: (() => void) | undefined,
  recordInteraction = captureNativeChatStructuredUserAction(transport)
): void {
  recordInteraction()
  emitNativeChatMessageSent({ agent, runtime: transport.runtime })
  reveal?.()
}
