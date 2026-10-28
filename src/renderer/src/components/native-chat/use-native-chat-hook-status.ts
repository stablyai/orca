import { useAppStore } from '../../store'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import {
  nativeChatHookHasWorkingSubagents,
  resolveNativeChatHookState
} from '../../../../shared/native-chat/native-chat-live-status'

export function useNativeChatHookStatus(
  paneKey: string
): readonly [AgentStatusState | null, number | null, boolean] {
  // Subscribe to TTL expiry so silent working rows eventually stop keeping chat busy.
  const agentStatusEpoch = useAppStore((store) => store.agentStatusEpoch)
  void agentStatusEpoch
  // Primitive selectors avoid rerenders for unrelated status changes.
  const state = useAppStore((store) =>
    resolveNativeChatHookState(store.agentStatusByPaneKey[paneKey])
  )
  const stateStartedAt = useAppStore(
    (store) => store.agentStatusByPaneKey[paneKey]?.stateStartedAt ?? null
  )
  const hasWorkingSubagents = useAppStore((store) =>
    nativeChatHookHasWorkingSubagents(store.agentStatusByPaneKey[paneKey])
  )
  return [state, stateStartedAt, hasWorkingSubagents]
}
