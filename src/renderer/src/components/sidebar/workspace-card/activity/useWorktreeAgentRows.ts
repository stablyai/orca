import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAppStateView } from '@/store/retained-views/app-state-view'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { createWorktreeAgentRowsSelector, EMPTY_AGENT_ROWS } from './worktree-agent-rows-projection'

const subscribeToNothing = (): (() => void) => () => {}

export function useWorktreeAgentRows(worktreeId: string, active = true, hostId?: ExecutionHostId) {
  const store = useAppStateView()
  const selectRows = useMemo(
    () => createWorktreeAgentRowsSelector(worktreeId, hostId),
    [worktreeId, hostId]
  )
  const getRows = useCallback(
    () => (active ? selectRows(store.getState()) : EMPTY_AGENT_ROWS),
    [active, selectRows, store]
  )
  return useSyncExternalStore(active ? store.subscribe : subscribeToNothing, getRows, getRows)
}
