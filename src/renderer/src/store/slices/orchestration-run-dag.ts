import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  OrchestrationRunDag,
  OrchestrationTaskDispatch,
  OrchestrationTaskNode,
  OrchestrationTaskSignal
} from '../../../../shared/runtime-types'

// Why (#6 O1): per-coordinator live task DAG synced from main
// (RuntimeSyncWindowGraphResult), keyed by the coordinator's paneKey — the same
// keying as orchestrationActivityByPaneKey. Lets Mission Control render the
// run's actual DAG (tasks + worker state) rather than only aggregate counts.
// Real-time only; not persisted.
export type OrchestrationRunDagSlice = {
  orchestrationRunDagByPaneKey: Record<string, OrchestrationRunDag>
  setOrchestrationRunDagByPaneKey: (entries: Record<string, OrchestrationRunDag>) => void
}

function dispatchesEqual(
  a: OrchestrationTaskDispatch | null,
  b: OrchestrationTaskDispatch | null
): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return (
    a.assigneeHandle === b.assigneeHandle &&
    a.assigneeAgent === b.assigneeAgent &&
    a.status === b.status &&
    a.lastHeartbeatAt === b.lastHeartbeatAt &&
    a.stale === b.stale
  )
}

function signalsEqual(
  a: OrchestrationTaskSignal | null,
  b: OrchestrationTaskSignal | null
): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return a.phase === b.phase && a.summary === b.summary
}

function tasksEqual(a: OrchestrationTaskNode, b: OrchestrationTaskNode): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.title === b.title &&
    a.targetKey === b.targetKey &&
    a.deps.length === b.deps.length &&
    a.deps.every((dep, i) => dep === b.deps[i]) &&
    dispatchesEqual(a.dispatch, b.dispatch) &&
    signalsEqual(a.signal, b.signal)
  )
}

function dagsEqual(a: OrchestrationRunDag, b: OrchestrationRunDag): boolean {
  return (
    a.runId === b.runId &&
    a.recipe === b.recipe &&
    a.truncatedTaskCount === b.truncatedTaskCount &&
    a.tasks.length === b.tasks.length &&
    a.tasks.every((task, i) => b.tasks[i] !== undefined && tasksEqual(task, b.tasks[i]!))
  )
}

function dagMapsEqual(
  a: Record<string, OrchestrationRunDag>,
  b: Record<string, OrchestrationRunDag>
): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) {
    return false
  }
  return aKeys.every((key) => b[key] !== undefined && dagsEqual(a[key]!, b[key]!))
}

export const createOrchestrationRunDagSlice: StateCreator<
  AppState,
  [],
  [],
  OrchestrationRunDagSlice
> = (set) => ({
  orchestrationRunDagByPaneKey: {},
  setOrchestrationRunDagByPaneKey: (entries) => {
    // Why: graph sync fires on high-frequency title ticks. Only replace the map
    // reference when its contents actually changed so the Control Panel does not
    // re-render every tick (mirrors orchestration-activity.ts).
    set((s) =>
      dagMapsEqual(s.orchestrationRunDagByPaneKey, entries)
        ? s
        : { orchestrationRunDagByPaneKey: entries }
    )
  }
})
