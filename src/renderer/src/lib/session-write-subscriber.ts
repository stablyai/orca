import type { AppState } from '../store'
import { isDecorativeAgentTitleFrameChange } from '../../../shared/agent-decorative-title-signature'
import type { WorkspaceSessionPatch } from '../../../shared/workspace-session-state-types'
import { SESSION_RELEVANT_FIELDS, shouldPersistWorkspaceSession } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'
import { createWorktreeTabBucketProjection } from './worktree-tab-bucket-projection'

type SessionRelevantField = (typeof SESSION_RELEVANT_FIELDS)[number]
type TabsByWorktree = AppState['tabsByWorktree']
type TerminalTab = TabsByWorktree[string][number]
type UnifiedTabsByWorktree = AppState['unifiedTabsByWorktree']
type UnifiedTab = UnifiedTabsByWorktree[string][number]

const TERMINAL_TAB_LIVE_TITLE_KEYS = new Set<keyof TerminalTab>(['title'])
// Handoff flags are stripped from sessions; toggling alone must not rebuild durable payloads.
const TERMINAL_TAB_TRANSIENT_SESSION_KEYS = new Set<keyof TerminalTab>([
  'pendingActivationSpawn',
  'recovery'
])

function terminalTabChangedForSession(prev: TerminalTab, next: TerminalTab): boolean {
  if (prev === next) {
    return false
  }
  const keys = new Set([
    ...(Object.keys(prev) as (keyof TerminalTab)[]),
    ...(Object.keys(next) as (keyof TerminalTab)[])
  ])
  for (const key of keys) {
    if (TERMINAL_TAB_LIVE_TITLE_KEYS.has(key) || TERMINAL_TAB_TRANSIENT_SESSION_KEYS.has(key)) {
      continue
    }
    if (prev[key] !== next[key]) {
      return true
    }
  }
  return prev.title !== next.title && !isDecorativeAgentTitleFrameChange(prev.title, next.title)
}
function createTerminalSessionTabsProjection() {
  return createWorktreeTabBucketProjection<TerminalTab, TerminalTab>({
    projectTab: (tab) => tab,
    isSameProjectedTab: (previousTab, nextTab) =>
      !terminalTabChangedForSession(previousTab, nextTab)
  })
}

function unifiedTabChangedForSession(prev: UnifiedTab, next: UnifiedTab): boolean {
  if (prev === next) {
    return false
  }
  const keys = new Set([
    ...(Object.keys(prev) as (keyof UnifiedTab)[]),
    ...(Object.keys(next) as (keyof UnifiedTab)[])
  ])
  for (const key of keys) {
    if (key === 'label') {
      continue
    }
    if (prev[key] !== next[key]) {
      return true
    }
  }
  if (prev.label === next.label) {
    return false
  }
  if (prev.contentType !== 'terminal' || next.contentType !== 'terminal') {
    return true
  }
  return !isDecorativeAgentTitleFrameChange(prev.label, next.label)
}
function createUnifiedSessionTabsProjection() {
  return createWorktreeTabBucketProjection<UnifiedTab, UnifiedTab>({
    projectTab: (tab) => tab,
    isSameProjectedTab: (previousTab, nextTab) => !unifiedTabChangedForSession(previousTab, nextTab)
  })
}

export type WorkspaceSessionWrite = {
  patch: WorkspaceSessionPatch
}

export type SessionWriteSubscriberDeps = {
  store: {
    subscribe: (listener: (state: AppState) => void) => () => void
    getState: () => AppState
  }
  persist: (payload: WorkspaceSessionWrite) => void | Promise<void>
  onPersistError?: (error: unknown) => void
  debounceMs?: number
}

// Expose the real subscriber for mutation-gate tests; unrelated status/usage/title ticks can otherwise silently breach timer budgets.
export function createSessionWriteSubscriber({
  store,
  persist,
  onPersistError,
  debounceMs = 150
}: SessionWriteSubscriberDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let writing = false
  // Every store update fires this subscriber; gate unrelated ticks before debounce/payload work (formerly 70–110ms). Durable tab projections retain identity for display-only frames but refresh on real session changes; null permits the first write.
  let prev: Record<string, unknown> | null = null
  // prev holds projected maps; retain raw identities separately for the allocation-free scan.
  let prevTabsSource: TabsByWorktree | null = null
  let prevUnifiedTabsSource: UnifiedTabsByWorktree | null = null
  // Pending fields are the only owed-write ledger after prev advances. In-flight writes own their fields until ACK; failures merge them back without replacing newer same-field edits.
  const pendingChangedFields = new Set<SessionRelevantField>()
  const terminalTabsProjection = createTerminalSessionTabsProjection()
  const unifiedTabsProjection = createUnifiedSessionTabsProjection()
  const flushPendingWrite = (): void => {
    timer = null
    if (disposed || writing || pendingChangedFields.size === 0) {
      return
    }
    // Build from live getState, not the scheduled snapshot; future payload inputs outside the timer-gated fields must not silently persist stale values.
    const fresh = store.getState()
    // Closed persistence gates defer without discarding pending fields; the next store update rearms, with no timer churn while closed.
    if (!shouldPersistWorkspaceSession(fresh)) {
      return
    }
    const changed = new Set(pendingChangedFields)
    pendingChangedFields.clear()
    const patch = buildWorkspaceSessionPatch(fresh, changed)
    if (Object.keys(patch).length === 0) {
      return
    }
    writing = true
    const settle = (failed: boolean, error?: unknown): void => {
      writing = false
      if (disposed) {
        return
      }
      if (failed) {
        for (const field of changed) {
          pendingChangedFields.add(field)
        }
        // A rejection waits for the next store wake, not a retry loop.
        onPersistError?.(error)
      } else if (pendingChangedFields.size > 0) {
        armFlushTimer()
      }
    }
    try {
      const result = persist({ patch })
      if (result && typeof result.then === 'function') {
        void result.then(
          () => settle(false),
          (error: unknown) => settle(true, error)
        )
      } else {
        settle(false)
      }
    } catch (error) {
      settle(true, error)
    }
  }

  const armFlushTimer = (): void => {
    if (disposed || writing) {
      return
    }
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(flushPendingWrite, debounceMs)
  }

  /** Scan raw relevant identities without allocation. For projected maps, unchanged source implies unchanged projection; changed sources still pass through full projected comparison. */
  const hasSessionFieldIdentityChange = (state: AppState): boolean => {
    if (prev === null) {
      return true
    }
    for (const key of SESSION_RELEVANT_FIELDS) {
      const unchanged =
        key === 'tabsByWorktree'
          ? state.tabsByWorktree === prevTabsSource
          : key === 'unifiedTabsByWorktree'
            ? state.unifiedTabsByWorktree === prevUnifiedTabsSource
            : prev[key] === state[key]
      if (!unchanged) {
        return true
      }
    }
    return false
  }

  const evaluateSessionState = (state: AppState): void => {
    if (!shouldPersistWorkspaceSession(state)) {
      return
    }
    // Most store writes touch no session fields; scan identities before allocating snapshots/changed lists.
    if (!hasSessionFieldIdentityChange(state)) {
      if (pendingChangedFields.size === 0) {
        return
      }
      // An unrelated update may wake a deferred write but must never reset an armed debounce.
      if (timer !== null) {
        return
      }
      armFlushTimer()
      return
    }
    const next: Record<string, unknown> = {}
    for (const key of SESSION_RELEVANT_FIELDS) {
      const value = state[key]
      next[key] =
        key === 'tabsByWorktree'
          ? terminalTabsProjection.project(value as TabsByWorktree)
          : key === 'unifiedTabsByWorktree'
            ? unifiedTabsProjection.project(value as UnifiedTabsByWorktree)
            : value
    }
    const changedFields =
      prev === null
        ? [...SESSION_RELEVANT_FIELDS]
        : SESSION_RELEVANT_FIELDS.filter((key) => prev?.[key] !== next[key])
    // Equivalent projections still consume the new source identities.
    prevTabsSource = state.tabsByWorktree
    prevUnifiedTabsSource = state.unifiedTabsByWorktree
    if (changedFields.length === 0 && pendingChangedFields.size === 0) {
      return
    }
    prev = next
    for (const field of changedFields) {
      pendingChangedFields.add(field)
    }
    // Unrelated updates may wake deferred writes but must not reset an armed debounce and recreate reset storms.
    if (timer !== null && changedFields.length === 0) {
      return
    }
    armFlushTimer()
  }

  // Seed the initial full write from current state when the gate is already open; unchanged catalogs no longer guarantee an incidental wake tick.
  evaluateSessionState(store.getState())
  const unsub = store.subscribe(evaluateSessionState)

  return () => {
    disposed = true
    unsub()
    if (timer !== null) {
      clearTimeout(timer)
    }
    pendingChangedFields.clear()
  }
}
