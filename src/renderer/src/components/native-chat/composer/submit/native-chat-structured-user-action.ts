import { useAppStore } from '@/store/index'
import { emitNativeChatMessageSent } from '@/components/native-chat/telemetry/native-chat-telemetry'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'

// User admission owns reveal; draft consumption belongs only to draft submission.
export function completeNativeChatStructuredUserAction(
  agent: AgentType,
  transport: NativeChatStructuredComposerTransport,
  reveal: (() => void) | undefined
): void {
  const state = useAppStore.getState()
  if (transport.tabId && transport.worktreeId) {
    state.recordTabInteraction(transport.tabId, { worktreeId: transport.worktreeId })
  }
  emitNativeChatMessageSent({ agent, runtime: transport.runtime })
  reveal?.()
}
