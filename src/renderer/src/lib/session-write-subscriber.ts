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
// Why: this handoff flag is stripped from workspace sessions, so toggling it
// alone should not rebuild and rewrite the durable session payload.
const TERMINAL_TAB_TRANSIENT_SESSION_KEYS = new Set<keyof TerminalTab>(['pendingActivationSpawn'])

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

/**
 * Why the two are one unit and not two optional callbacks: a gate can reopen on a wall clock (the
 * direct-SSH apply's suppression tail) with no store update behind it. A caller that supplies the
 * gate but no wake-up would strand every write deferred in that window until some unrelated
 * mutation happened along — the failure this deferral exists to prevent. Pairing them in the type
 * makes that combination unwriteable rather than merely discouraged.
 */
type SessionWritePersistGate =
  | { shouldSchedulePersist?: undefined; subscribeToPersistGateOpen?: undefined }
  | {
      /** False defers the write; it never drops it. */
      shouldSchedulePersist: () => boolean
      /** Called when the gate may have reopened. Returns an unsubscribe. */
      subscribeToPersistGateOpen: (onGateOpen: () => void) => () => void
    }

export type SessionWriteSubscriberDeps = {
  store: {
    subscribe: (listener: (state: AppState) => void) => () => void
    getState: () => AppState
  }
  persist: (payload: WorkspaceSessionWrite) => void
  debounceMs?: number
} & SessionWritePersistGate

/**
 * Why: factored out so a vitest can drive the real Zustand store and assert
 * which mutations cause a session write — the gate against unrelated updates
 * (agent status, usage, runtime title ticks) is load-bearing for setTimeout
 * violation budgets and the failure mode is silent.
 */
export function createSessionWriteSubscriber({
  store,
  persist,
  shouldSchedulePersist,
  subscribeToPersistGateOpen,
  debounceMs = 150
}: SessionWriteSubscriberDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  // Why: the subscriber fires on every store update (agent status, usage
  // refreshes, runtime title ticks, …). Without this gate each fire reset
  // the debounce, and when it finally expired buildWorkspaceSessionPayload
  // crossed 70-110ms with many tabs, tripping setTimeout violations. Terminal
  // and unified maps use durable per-worktree projections, so display frames
  // reuse the prior identity while a real session change keeps fresh tabs for
  // the eventual getState() patch build. `null` makes the first fire proceed.
  let prev: Record<string, unknown> | null = null
  // Why: this set is the only record that a mutation still owes a write — `prev` has already
  // advanced past it, and change detection is identity-based, so a field dropped from here can
  // never be re-detected. It is retired only by a flush that reached `persist` (or found nothing
  // left to write), and by unsubscribe. A closed gate never retires it.
  const pendingChangedFields = new Set<SessionRelevantField>()
  const terminalTabsProjection = createTerminalSessionTabsProjection()
  const unifiedTabsProjection = createUnifiedSessionTabsProjection()

  const flushPendingWrite = (): void => {
    timer = null
    // Why: rebuild from the freshest store state rather than the snapshot
    // captured when this timer was scheduled. Today this is equivalent
    // because buildWorkspaceSessionPayload reads only SESSION_RELEVANT_FIELDS
    // (the same fields gating the timer reset), so the captured `state` is
    // already current for those fields. Calling getState() guards against a
    // future refactor that adds a non-relevant field read to the payload
    // builder — without this, such a change would silently start emitting
    // stale values for that field.
    const fresh = store.getState()
    // Why: a closed gate defers, it never discards. Returning with the pending set intact leaves
    // the write owed; the next store update or gate-open wake-up re-arms it. Nothing re-arms from
    // here, so a gate that never reopens costs no timer.
    if (!shouldPersistWorkspaceSession(fresh)) {
      return
    }
    if (shouldSchedulePersist && !shouldSchedulePersist()) {
      return
    }
    const changed = new Set(pendingChangedFields)
    pendingChangedFields.clear()
    const patch = buildWorkspaceSessionPatch(fresh, changed)
    if (Object.keys(patch).length === 0) {
      return
    }
    persist({ patch })
  }

  const armFlushTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(flushPendingWrite, debounceMs)
  }

  const unsub = store.subscribe((state) => {
    if (!shouldPersistWorkspaceSession(state)) {
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
    if (changedFields.length === 0 && pendingChangedFields.size === 0) {
      return
    }
    prev = next
    for (const field of changedFields) {
      pendingChangedFields.add(field)
    }
    if (shouldSchedulePersist && !shouldSchedulePersist()) {
      return
    }
    // Why: an unrelated update may wake a deferred write but must never reset an armed debounce —
    // that reset storm is exactly what the changed-field gate above exists to prevent.
    if (timer !== null && changedFields.length === 0) {
      return
    }
    armFlushTimer()
  })

  const unsubGateOpen = subscribeToPersistGateOpen?.(() => {
    if (pendingChangedFields.size === 0 || timer !== null) {
      return
    }
    armFlushTimer()
  })

  return () => {
    unsub()
    unsubGateOpen?.()
    if (timer !== null) {
      clearTimeout(timer)
    }
    pendingChangedFields.clear()
  }
}
