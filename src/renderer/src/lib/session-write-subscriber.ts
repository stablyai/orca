import type { AppState } from '../store'
import type { WorkspaceSessionState } from '../../../shared/types'
import { buildWorkspaceSessionPayload, SESSION_RELEVANT_FIELDS } from './workspace-session'

export type SessionWriteSubscriberDeps = {
  store: {
    subscribe: (listener: (state: AppState) => void) => () => void
    getState: () => AppState
  }
  persist: (payload: WorkspaceSessionState) => void
  debounceMs?: number
}

/**
 * Why: factored out so a vitest can drive the real Zustand store and assert
 * which mutations cause a session write — the gate against unrelated updates
 * (agent status, usage, runtime title ticks) is load-bearing for setTimeout
 * violation budgets and the failure mode is silent.
 */
export function createSessionWriteSubscriber({
  store,
  persist,
  debounceMs = 150
}: SessionWriteSubscriberDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  // Why: the subscriber fires on every store update (agent status, usage
  // refreshes, runtime title ticks, …). Without this gate each fire reset
  // the debounce, and when it finally expired buildWorkspaceSessionPayload
  // crossed 70-110ms with many tabs, tripping setTimeout violations. Compare
  // each session-feeding field by reference against the prior snapshot and
  // skip both the timer reset and the rebuild when none changed. `null`
  // sentinel guarantees the very first fire always proceeds.
  let prev: Record<string, unknown> | null = null

  const unsub = store.subscribe((state) => {
    if (!state.workspaceSessionReady) {
      return
    }
    let changed = false
    if (prev === null) {
      changed = true
    } else {
      for (const key of SESSION_RELEVANT_FIELDS) {
        if (prev[key] !== state[key]) {
          changed = true
          break
        }
      }
    }
    if (!changed) {
      return
    }
    const next: Record<string, unknown> = {}
    for (const key of SESSION_RELEVANT_FIELDS) {
      next[key] = state[key]
    }
    prev = next
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      timer = null
      // Why: rebuild from the freshest store state rather than the snapshot
      // captured when this timer was scheduled. Today this is equivalent
      // because buildWorkspaceSessionPayload reads only SESSION_RELEVANT_FIELDS
      // (the same fields gating the timer reset), so the captured `state` is
      // already current for those fields. Calling getState() guards against a
      // future refactor that adds a non-relevant field read to the payload
      // builder — without this, such a change would silently start emitting
      // stale values for that field.
      persist(buildWorkspaceSessionPayload(store.getState()))
    }, debounceMs)
  })

  return () => {
    unsub()
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}
