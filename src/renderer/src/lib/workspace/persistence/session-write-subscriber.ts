import type { AppState } from '../../../store/types'
import type { WorkspaceSessionPatch } from '../../../../../shared/workspace-session/workspace-session-state-types'
import {
  SESSION_RELEVANT_FIELDS,
  shouldPersistWorkspaceSession,
  type SessionRelevantField
} from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'
import {
  buildWorkspaceSessionKeyedWrite,
  type WorkspaceSessionKeyedWrite
} from './workspace-session-keyed-write'
import {
  createTerminalTitleScopedProjection,
  createUnifiedTitleScopedProjection,
  type TitleChangeScope
} from './session-write-tab-changes'
import { createBrowserSessionHandlesProjection } from './browser-session-handles-projection'
import { createUnifiedTabSessionCache } from './workspace-session-unified-tabs'
import { endUnifiedTabSave } from './workspace-session-launch-slots'
import { SESSION_ROUTING_FIELDS } from './workspace-session-host-routing'

type TabsByWorktree = AppState['tabsByWorktree']
type UnifiedTabsByWorktree = AppState['unifiedTabsByWorktree']

export type WorkspaceSessionWrite = {
  patch: WorkspaceSessionPatch
  /** The changed store fields the patch was built from. */
  fields: readonly SessionRelevantField[]
}

type PendingScope = { tabs: TitleChangeScope['tabs']; worktreeIds: Set<string> }

type PersistOutcome = Promise<void | { pendingFields?: readonly SessionRelevantField[] }>
type PersistResult = void | PersistOutcome

export type SessionWriteSubscriberDeps = {
  store: {
    subscribe: (listener: (state: AppState) => void) => () => void
    getState: () => AppState
  }
  /** `pendingFields`: accepted but not applied yet (a fenced partition); kept for the next store wake. */
  persist: (payload: WorkspaceSessionWrite) => PersistResult
  /** Sends only the changed workspace keys; null when it can't stand in for the whole write. */
  persistKeyed?: (write: WorkspaceSessionKeyedWrite) => PersistOutcome | null
  /** Whether a keyed write of these fields could be sent; checked before one is built. */
  keyedWriteReady?: (fields: readonly SessionRelevantField[]) => boolean
  onPersistError?: (error: unknown) => void
  debounceMs?: number
}

// Expose the real subscriber for mutation-gate tests; unrelated status/usage/title ticks can otherwise silently breach timer budgets.
export function createSessionWriteSubscriber({
  store,
  persist,
  persistKeyed,
  keyedWriteReady,
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
  let prevBrowserHandlesSource: AppState['remoteBrowserPageHandlesByPageId'] | null = null
  // Pending fields are the only owed-write ledger after prev advances: per field, the workspaces whose
  // titles changed, or 'whole'. In-flight writes own their fields until ACK; failures merge them back
  // as 'whole' without replacing newer same-field edits.
  const pendingChangedFields = new Map<SessionRelevantField, PendingScope | 'whole'>()
  const markPending = (field: SessionRelevantField, scope: TitleChangeScope | 'whole'): void => {
    const pending = pendingChangedFields.get(field)
    if (scope === 'whole' || pending === 'whole' || (pending && pending.tabs !== scope.tabs)) {
      pendingChangedFields.set(field, 'whole')
    } else if (pending) {
      // The ledger owns its set: a burst inserts each workspace once rather than recopying the set.
      scope.worktreeIds.forEach((worktreeId) => pending.worktreeIds.add(worktreeId))
    } else {
      pendingChangedFields.set(field, { tabs: scope.tabs, worktreeIds: new Set(scope.worktreeIds) })
    }
  }
  // Accepted but not applied (a fenced partition): they ride along with the next real session change.
  const deferredFields = new Set<SessionRelevantField>()
  const terminalTabsProjection = createTerminalTitleScopedProjection()
  const unifiedTabsProjection = createUnifiedTitleScopedProjection()
  const browserHandlesProjection = createBrowserSessionHandlesProjection()
  const unifiedTabSessionCache = createUnifiedTabSessionCache()
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
    const changed = new Map(pendingChangedFields)
    const fields = [...changed.keys()]
    pendingChangedFields.clear()
    writing = true
    const settle = (
      failed: boolean,
      error?: unknown,
      pendingFields: readonly SessionRelevantField[] = []
    ): void => {
      writing = false
      if (disposed) {
        return
      }
      for (const field of pendingFields) {
        deferredFields.add(field)
      }
      if (failed) {
        for (const field of fields) {
          markPending(field, 'whole')
        }
        // A rejection waits for the next store wake, not a retry loop.
        onPersistError?.(error)
      } else if (pendingChangedFields.size > 0) {
        // A real change is already queued: it carries the deferred fields too.
        for (const field of deferredFields) {
          markPending(field, 'whole')
        }
        deferredFields.clear()
        armFlushTimer()
      }
    }
    try {
      const result = persistChangedKeys(fresh, changed) ?? persistWhole(fresh, fields)
      if (result === null) {
        writing = false
        return
      }
      if (result && typeof result.then === 'function') {
        void result.then(
          (outcome) => settle(false, undefined, outcome?.pendingFields),
          (error: unknown) => settle(true, error)
        )
      } else {
        settle(false)
      }
    } catch (error) {
      settle(true, error)
    } finally {
      endUnifiedTabSave(unifiedTabSessionCache)
    }
  }

  /** A title-only change sends its workspaces' keys; null leaves the write to the whole path. */
  const persistChangedKeys = (
    fresh: AppState,
    changed: ReadonlyMap<SessionRelevantField, TitleChangeScope | 'whole'>
  ): PersistOutcome | null => {
    if (!persistKeyed) {
      return null
    }
    const scopes = new Map<SessionRelevantField, TitleChangeScope>()
    for (const [field, scope] of changed) {
      if (scope === 'whole') {
        return null
      }
      scopes.set(field, scope)
    }
    if (keyedWriteReady && !keyedWriteReady([...scopes.keys()])) {
      return null
    }
    try {
      const write = buildWorkspaceSessionKeyedWrite(fresh, scopes, unifiedTabSessionCache)
      return write ? persistKeyed(write) : null
    } catch (error) {
      // The whole path rebuilds every key, so a keyed failure costs only this write's speed.
      onPersistError?.(error)
      return null
    }
  }

  /** Null when nothing changed in what the session saves. */
  const persistWhole = (
    fresh: AppState,
    fields: readonly SessionRelevantField[]
  ): PersistResult | null => {
    const patch = buildWorkspaceSessionPatch(fresh, fields, unifiedTabSessionCache)
    return Object.keys(patch).length === 0 ? null : persist({ patch, fields })
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
            : key === 'remoteBrowserPageHandlesByPageId'
              ? state.remoteBrowserPageHandlesByPageId === prevBrowserHandlesSource
              : prev[key] === state[key]
      if (!unchanged) {
        return true
      }
    }
    return false
  }

  let prevRoutingInputs: readonly unknown[] | null = null
  const evaluateSessionState = (state: AppState): void => {
    if (!shouldPersistWorkspaceSession(state)) {
      return
    }
    if (
      SESSION_ROUTING_FIELDS.some((field, index) => state[field] !== prevRoutingInputs?.[index])
    ) {
      prevRoutingInputs = SESSION_ROUTING_FIELDS.map((field) => state[field])
      // Owed keys were judged under the old routing; the whole path re-splits them.
      for (const field of pendingChangedFields.keys()) {
        markPending(field, 'whole')
      }
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
            : key === 'remoteBrowserPageHandlesByPageId'
              ? browserHandlesProjection(state.remoteBrowserPageHandlesByPageId)
              : value
    }
    const changedFields =
      prev === null
        ? [...SESSION_RELEVANT_FIELDS]
        : SESSION_RELEVANT_FIELDS.filter((key) => prev?.[key] !== next[key])
    const scopeOf = (field: SessionRelevantField): TitleChangeScope | 'whole' =>
      terminalTabsProjection.scopeOf(next[field]) ??
      unifiedTabsProjection.scopeOf(next[field]) ??
      'whole'
    const changedScopes = changedFields.map((field) => [field, scopeOf(field)] as const)
    // Equivalent projections still consume the new source identities.
    prevTabsSource = state.tabsByWorktree
    prevUnifiedTabsSource = state.unifiedTabsByWorktree
    prevBrowserHandlesSource = state.remoteBrowserPageHandlesByPageId
    if (changedFields.length === 0 && pendingChangedFields.size === 0) {
      return
    }
    prev = next
    for (const [field, scope] of changedScopes) {
      markPending(field, scope)
    }
    if (changedFields.length > 0) {
      for (const field of deferredFields) {
        markPending(field, 'whole')
      }
      deferredFields.clear()
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
