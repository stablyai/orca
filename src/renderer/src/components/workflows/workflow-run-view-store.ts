import { useEffect } from 'react'
import { create } from 'zustand'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { WorkflowMetrics } from '../../../../shared/workflow/workflow-metrics'
import {
  isWorkflowRunTerminal,
  type WorkflowRun
} from '../../../../shared/workflow/workflow-run-types'
import { workflowRpc } from './workflow-rpc'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'

const POLL_MS = 1_000
/** How long a real delivery keeps its edge highlighted. */
export const WORKFLOW_EDGE_ACTIVITY_MS = 1_600

type WorkflowRunViewState = {
  target: RuntimeClientTarget | null
  runId: string | null
  run: WorkflowRun | null
  metrics: WorkflowMetrics | null
  error: string | null
  /** edgeId → time of its latest observed delivery event. */
  edgeActivity: Record<string, number>
  watch: (target: RuntimeClientTarget, runId: string) => void
  clear: () => void
  apply: (run: WorkflowRun, metrics: WorkflowMetrics) => void
  fail: (error: string) => void
}

export const useWorkflowRunViewStore = create<WorkflowRunViewState>((set, get) => ({
  target: null,
  runId: null,
  run: null,
  metrics: null,
  error: null,
  edgeActivity: {},
  watch: (target, runId) =>
    set({
      target,
      runId,
      run: get().runId === runId ? get().run : null,
      metrics: null,
      error: null,
      edgeActivity: {}
    }),
  clear: () =>
    set({ target: null, runId: null, run: null, metrics: null, error: null, edgeActivity: {} }),
  apply: (incoming, metrics) => {
    const previous = get().run
    const events =
      previous && previous.id === incoming.id
        ? [...previous.events, ...incoming.events]
        : incoming.events
    const activity = { ...get().edgeActivity }
    const now = Date.now()
    if (previous) {
      for (const event of incoming.events) {
        const edgeId = event.data?.edgeId
        if (event.kind === 'message-delivered' && typeof edgeId === 'string') {
          activity[edgeId] = now
        }
      }
    }
    set({ run: { ...incoming, events }, metrics, error: null, edgeActivity: activity })
  },
  fail: (error) => set({ error })
}))

/** Fetch one delta into the store; resolves true once the run has settled. */
async function pollWorkflowRunOnce(
  target: RuntimeClientTarget,
  runId: string,
  isCancelled: () => boolean
): Promise<boolean> {
  const state = useWorkflowRunViewStore.getState()
  const afterSeq = state.run?.id === runId ? (state.run.events.at(-1)?.seq ?? -1) : undefined
  try {
    const result = await workflowRpc.getRun(target, runId, afterSeq)
    if (isCancelled()) {
      return false
    }
    useWorkflowRunViewStore.getState().apply(result.run, result.metrics)
    return isWorkflowRunTerminal(result.run.status)
  } catch (error) {
    if (!isCancelled()) {
      useWorkflowRunViewStore
        .getState()
        .fail(error instanceof Error ? error.message : String(error))
    }
    return false
  }
}

/** Poll the authoritative run record; deltas only, and stop once the run has settled. */
export function useWorkflowRunPolling(): void {
  const target = useWorkflowRunViewStore((state) => state.target)
  const runId = useWorkflowRunViewStore((state) => state.runId)
  useEffect(() => {
    if (!target || !runId) {
      return
    }
    let cancelled = false
    let inFlight = false
    let stopPolling: (() => void) | null = null
    const tick = (): void => {
      if (inFlight || cancelled) {
        return
      }
      inFlight = true
      void pollWorkflowRunOnce(target, runId, () => cancelled).then((settled) => {
        inFlight = false
        if (settled) {
          stopPolling?.()
          stopPolling = null
        }
      })
    }
    // Runs once now; hidden windows pause polling and a settled run stops it.
    stopPolling = installWindowVisibilityInterval({
      run: tick,
      intervalMs: POLL_MS,
      slowWhileUnfocused: true
    })
    return () => {
      cancelled = true
      stopPolling?.()
    }
  }, [target, runId])
}

/** Restart polling after an action that may revive a settled run (retry, resume). */
export function refreshWorkflowRun(): void {
  const { target, runId, watch } = useWorkflowRunViewStore.getState()
  if (target && runId) {
    watch({ ...target }, runId)
  }
}
