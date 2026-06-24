import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { OrchestrationActivity } from '../../../../shared/runtime-types'

// Why: in-flight orchestration runs synced from main (RuntimeSyncWindowGraphResult),
// keyed by the coordinator's paneKey. Separate from agentStatusByPaneKey because
// it is DB-backed run state, not a per-pane agent hook — it lets an Orcastrator's
// sidebar dot show "supervising" when the director's turn ended but background
// workers are still live. Real-time only; not persisted.
export type OrchestrationActivitySlice = {
  orchestrationActivityByPaneKey: Record<string, OrchestrationActivity>
  setOrchestrationActivityByPaneKey: (entries: Record<string, OrchestrationActivity>) => void
}

function activitiesEqual(a: OrchestrationActivity, b: OrchestrationActivity): boolean {
  return (
    a.runId === b.runId &&
    a.pendingTasks === b.pendingTasks &&
    a.activeDispatches === b.activeDispatches &&
    a.staleDispatches === b.staleDispatches
  )
}

function activityMapsEqual(
  a: Record<string, OrchestrationActivity>,
  b: Record<string, OrchestrationActivity>
): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) {
    return false
  }
  return aKeys.every((key) => b[key] !== undefined && activitiesEqual(a[key]!, b[key]!))
}

export const createOrchestrationActivitySlice: StateCreator<
  AppState,
  [],
  [],
  OrchestrationActivitySlice
> = (set) => ({
  orchestrationActivityByPaneKey: {},
  setOrchestrationActivityByPaneKey: (entries) => {
    // Why: graph sync fires on high-frequency title ticks. Only replace the map
    // reference when its contents actually changed so subscribers selecting on
    // it do not re-render every tick.
    set((s) =>
      activityMapsEqual(s.orchestrationActivityByPaneKey, entries)
        ? s
        : { orchestrationActivityByPaneKey: entries }
    )
  }
})
