import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'
import type { AgentStatusState } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  nativeChatHookHasWorkingSubagents,
  resolveNativeChatHookState
} from '../../../../../../shared/native-chat/native-chat-live-status'

export function useNativeChatHookStatus(
  paneKey: string
): readonly [AgentStatusState | null, number | null, boolean] {
  // Primitive selectors avoid rerenders for unrelated status changes.
  const state = resolveNativeChatHookState(useAgentStatus(paneKey))
  const stateStartedAt = useAgentStatus(paneKey)?.stateStartedAt ?? null
  const hasWorkingSubagents = nativeChatHookHasWorkingSubagents(useAgentStatus(paneKey))
  return [state, stateStartedAt, hasWorkingSubagents]
}
