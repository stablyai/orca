import { useCallback, useSyncExternalStore } from 'react'
import { useAppStateView } from '@/store/retained-views/app-state-view'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

/** Reads the accepted owner directly; an unrelated pane never wakes this subscription. */
export function useAgentStatus(paneKey: string | null | undefined): AgentStatusEntry | undefined {
  const store = useAppStateView()
  const subscribe = useCallback(
    (listener: () => void) =>
      paneKey ? store.getState().agentStatusByPaneKey.subscribe(paneKey, listener) : () => {},
    [store, paneKey]
  )
  const read = useCallback(
    () => (paneKey ? store.getState().agentStatusByPaneKey.get(paneKey) : undefined),
    [store, paneKey]
  )
  return useSyncExternalStore(subscribe, read, read)
}
