import { useCallback, useSyncExternalStore } from 'react'
import { useAppStateView } from '@/store/retained-views/app-state-view'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

/** Reads the accepted owner directly; an unrelated pane never wakes this subscription. */
export function useAgentStatusSelector<T>(
  paneKey: string | null | undefined,
  select: (entry: AgentStatusEntry | undefined) => T
): T {
  const store = useAppStateView()
  const subscribe = useCallback(
    (listener: () => void) =>
      paneKey ? store.getState().agentStatusByPaneKey.subscribe(paneKey, listener) : () => {},
    [store, paneKey]
  )
  const read = useCallback(
    () => select(paneKey ? store.getState().agentStatusByPaneKey.get(paneKey) : undefined),
    [store, paneKey, select]
  )
  return useSyncExternalStore(subscribe, read, read)
}

const identity = (entry: AgentStatusEntry | undefined) => entry

export function useAgentStatus(paneKey: string | null | undefined): AgentStatusEntry | undefined {
  return useAgentStatusSelector(paneKey, identity)
}
