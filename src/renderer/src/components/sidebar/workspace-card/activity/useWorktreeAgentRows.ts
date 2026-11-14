import { useAppStateView, useAppStateViewActive } from '@/store/retained-views/app-state-view'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentStatusProjection } from '@/store/slices/agent-status/agent-status-projection'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  createWorktreeAgentRowsSelector,
  EMPTY_AGENT_ROWS,
  getSharedWorktreeAgentRowsSelector
} from './worktree-agent-rows-projection'

const subscribeToNothing = (): (() => void) => () => {}

export function useAgentPresentation<T>(
  channel: string,
  read: (projection: AgentStatusProjection) => T,
  active = true
): T {
  const store = useAppStateView()
  const projection = useStore(store, (state) => state.agentStatusByPaneKey.projection)
  const subscribe = useCallback(
    (listener: () => void) => projection.subscribe(channel, listener),
    [projection, channel]
  )
  const snapshot = useCallback(() => read(projection), [projection, read])
  return useSyncExternalStore(active ? subscribe : subscribeToNothing, snapshot, snapshot)
}

/** Full output is materialized only for callers that consume the actual list. */
export function useWorktreeAgentRows(
  worktreeId: string,
  active = true,
  hostId?: ExecutionHostId
): DashboardAgentRow[] {
  const store = useAppStateView()
  // Live reads share the rollup's selector; a retained view's frozen state keeps its own memo.
  const live = useAppStateViewActive()
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
  const rows = useAgentPresentation(`list\0${worktreeId}`, getRows, active)
  // Host attribution also reads layouts, PTYs and ownership the workspace channel does not carry.
  const hostRows = useSyncExternalStore(
    active && hostId ? store.subscribe : subscribeToNothing,
    getRows,
    getRows
  )
  return hostId ? hostRows : rows
}
export function useWorktreeAgentRow(paneKey: string): DashboardAgentRow | undefined {
  return useAgentPresentation(
    `row\0${paneKey}`,
    useCallback((p) => p.row(paneKey), [paneKey])
  )
}
