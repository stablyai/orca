import { useAppStateView } from '@/store/retained-views/app-state-view'
import { useCallback, useSyncExternalStore } from 'react'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentStatusProjection } from '@/store/slices/agent-status/agent-status-projection'

const EMPTY_ROWS: DashboardAgentRow[] = []
const EMPTY_KEYS: readonly string[] = Object.freeze([])
const subscribeToNothing = (): (() => void) => () => {}

export function useAgentPresentation<T>(
  channel: string,
  read: (projection: AgentStatusProjection) => T,
  active = true
): T {
  const store = useAppStateView()
  const projection = store((state) => state.agentStatusByPaneKey.projection)
  const subscribe = useCallback(
    (listener: () => void) => projection.subscribe(channel, listener),
    [projection, channel]
  )
  const snapshot = useCallback(() => read(projection), [projection, read])
  return useSyncExternalStore(active ? subscribe : subscribeToNothing, snapshot, snapshot)
}

/** Full output is materialized only for callers that consume the actual list. */
export function useWorktreeAgentRows(worktreeId: string, active = true): DashboardAgentRow[] {
  return useAgentPresentation(
    `list\0${worktreeId}`,
    useCallback((p) => (active ? p.list(worktreeId) : EMPTY_ROWS), [worktreeId, active]),
    active
  )
}
export function useWorktreeAgentKeys(worktreeId: string, active = true): readonly string[] {
  return useAgentPresentation(
    `keys\0${worktreeId}`,
    useCallback((p) => (active ? p.keys(worktreeId) : EMPTY_KEYS), [worktreeId, active]),
    active
  )
}
export function useWorktreeAgentRow(paneKey: string): DashboardAgentRow | undefined {
  return useAgentPresentation(
    `row\0${paneKey}`,
    useCallback((p) => p.row(paneKey), [paneKey])
  )
}
