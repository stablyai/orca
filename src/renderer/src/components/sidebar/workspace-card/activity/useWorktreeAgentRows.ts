import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { useAppStateView } from '@/store/retained-views/app-state-view'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  createWorktreeAgentRowsSelector,
  EMPTY_AGENT_ROWS,
  getSharedWorktreeAgentRowsSelector
} from './worktree-agent-rows-projection'

const subscribeToNothing = (): (() => void) => () => {}

export function useWorktreeAgentRows(worktreeId: string, active = true, hostId?: ExecutionHostId) {
  const store = useAppStateView()
  // Live reads share the rollup's selector; a retained view's frozen state keeps its own memo.
  const live = store === useAppStore
  const selectRows = useMemo(
    () =>
      live
        ? getSharedWorktreeAgentRowsSelector(worktreeId, hostId)
        : createWorktreeAgentRowsSelector(worktreeId, hostId),
    [live, worktreeId, hostId]
  )
  const getRows = useCallback(
    () => (active ? selectRows(store.getState()) : EMPTY_AGENT_ROWS),
    [active, selectRows, store]
  )
  return useSyncExternalStore(active ? store.subscribe : subscribeToNothing, getRows, getRows)
}
