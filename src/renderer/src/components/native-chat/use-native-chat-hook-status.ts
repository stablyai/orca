import { useAppStore } from '../../store'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import {
  nativeChatHookHasWorkingSubagents,
  resolveNativeChatHookState
} from '../../../../shared/native-chat/native-chat-live-status'

export function useNativeChatHookStatus(
  paneKey: string
): readonly [AgentStatusState | null, number | null, boolean] {
  // Store writes, including TTL epochs, re-evaluate freshness without selecting the global epoch.
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
