import type { AppState } from '../store'
import { isDecorativeAgentTitleFrameChange } from '../../../shared/agent-decorative-title-signature'
import type { WorkspaceSessionPatch } from '../../../shared/types'
import { SESSION_RELEVANT_FIELDS, shouldPersistWorkspaceSession } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'

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

function tabsByWorktreeChangedForSession(prev: TabsByWorktree, next: TabsByWorktree): boolean {
  if (prev === next) {
    return false
  }
  const worktreeIds = new Set([...Object.keys(prev), ...Object.keys(next)])
  for (const worktreeId of worktreeIds) {
    const prevTabs = prev[worktreeId] ?? []
    const nextTabs = next[worktreeId] ?? []
    if (prevTabs === nextTabs) {
      continue
    }
    if (prevTabs.length !== nextTabs.length) {
      return true
    }
    for (let i = 0; i < prevTabs.length; i += 1) {
      const prevTab = prevTabs[i]
      const nextTab = nextTabs[i]
      if (!prevTab || !nextTab || terminalTabChangedForSession(prevTab, nextTab)) {
        return true
      }
    }
  }
  return false
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

function unifiedTabsByWorktreeChangedForSession(
  prev: UnifiedTabsByWorktree,
  next: UnifiedTabsByWorktree
): boolean {
  if (prev === next) {
    return false
  }
  const worktreeIds = new Set([...Object.keys(prev), ...Object.keys(next)])
  for (const worktreeId of worktreeIds) {
    const prevTabs = prev[worktreeId] ?? []
    const nextTabs = next[worktreeId] ?? []
    if (prevTabs === nextTabs) {
      continue
    }
    if (prevTabs.length !== nextTabs.length) {
      return true
    }
    for (let i = 0; i < prevTabs.length; i += 1) {
      const prevTab = prevTabs[i]
      const nextTab = nextTabs[i]
      if (!prevTab || !nextTab || unifiedTabChangedForSession(prevTab, nextTab)) {
        return true
      }
    }
  }
  return false
}

function sessionRelevantFieldChanged(
  key: SessionRelevantField,
  prevValue: unknown,
  nextValue: unknown
): boolean {
  if (prevValue === nextValue) {
    return false
  }
  if (key === 'tabsByWorktree') {
    // Why: focused agent CLIs can emit spinner/title OSC frames many times per
    // second. Those labels are live UI chrome, not durable terminal topology.
    return tabsByWorktreeChangedForSession(prevValue as TabsByWorktree, nextValue as TabsByWorktree)
  }
  if (key === 'unifiedTabsByWorktree') {
    // Why: terminal live titles are mirrored into unified tab labels, so the
    // same decorative frames must not wake unified-tab session persistence.
    return unifiedTabsByWorktreeChangedForSession(
      prevValue as UnifiedTabsByWorktree,
      nextValue as UnifiedTabsByWorktree
    )
  }
  return true
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
  shouldSchedulePersist?: () => boolean
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
  shouldSchedulePersist,
  debounceMs = 150
}: SessionWriteSubscriberDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let persistFailureReported = false
  // Why: the subscriber fires on every store update (agent status, usage
  // refreshes, runtime title ticks, …). Without this gate each fire reset
  // the debounce, and when it finally expired buildWorkspaceSessionPayload
  // crossed 70-110ms with many tabs, tripping setTimeout violations. Compare
  // each session-feeding field by reference against the prior snapshot and
  // skip both the timer reset and the rebuild when none changed. `null`
  // sentinel guarantees the very first fire always proceeds.
  let prev: Record<string, unknown> | null = null
  const pendingChangedFields = new Set<SessionRelevantField>()
  const suppressionRetryMs = Math.max(debounceMs, 50)
  const persistFailureRetryMs = Math.max(debounceMs, 1_000)

  function scheduleFlush(delayMs: number, resetTimer: boolean): void {
    if (disposed || pendingChangedFields.size === 0) {
      return
    }
    if (timer !== null) {
      if (!resetTimer) {
        return
      }
      clearTimeout(timer)
    }
    timer = setTimeout(flushPending, delayMs)
  }

  function restoreFailedBatch(
    changed: ReadonlySet<SessionRelevantField>,
    error: unknown
  ): void {
    if (disposed) {
      return
    }
    if (!persistFailureReported) {
      persistFailureReported = true
      console.error('[session] Workspace session write failed; retrying:', error)
    }
    for (const field of changed) {
      pendingChangedFields.add(field)
    }
    scheduleFlush(persistFailureRetryMs, false)
  }

  function flushPending(): void {
    timer = null
    if (disposed || pendingChangedFields.size === 0) {
      return
    }

    // Why: rebuild from the freshest store state rather than the snapshot
    // captured when this timer was scheduled. Today this is equivalent
    // because buildWorkspaceSessionPayload reads only SESSION_RELEVANT_FIELDS
    // (the same fields gating the timer reset), so the captured `state` is
    // already current for those fields. Calling getState() guards against a
    // future refactor that adds a non-relevant field read to the payload
    // builder — without this, such a change would silently start emitting
    // stale values for that field.
    const fresh = store.getState()
    if (!shouldPersistWorkspaceSession(fresh)) {
      pendingChangedFields.clear()
      return
    }
    if (shouldSchedulePersist && !shouldSchedulePersist()) {
      // Why: remote-session apply can end without another Zustand update. Polling
      // the gate with one owned timer guarantees the retained batch eventually
      // flushes after suppression lifts instead of depending on incidental UI work.
      scheduleFlush(suppressionRetryMs, false)
      return
    }

    const changed = new Set(pendingChangedFields)
    const patch = buildWorkspaceSessionPatch(fresh, changed)
    if (Object.keys(patch).length === 0) {
      for (const field of changed) {
        pendingChangedFields.delete(field)
      }
      return
    }
    for (const field of changed) {
      pendingChangedFields.delete(field)
    }

    let result: void | Promise<void>
    try {
      result = persist({ patch })
    } catch (error) {
      // Why: synchronous adapters and async IPC writes share the same retry contract.
      restoreFailedBatch(changed, error)
      return
    }
    void Promise.resolve(result).then(
      () => {
        persistFailureReported = false
      },
      (error) => {
        // Why: the local IPC write owns durability. Restore the exact captured batch
        // on rejection so a transient failure cannot silently acknowledge lost state.
        restoreFailedBatch(changed, error)
      }
    )
  }

  const unsub = store.subscribe((state) => {
    if (!shouldPersistWorkspaceSession(state)) {
      return
    }
    const changedFields: SessionRelevantField[] = []
    if (prev === null) {
      changedFields.push(...SESSION_RELEVANT_FIELDS)
    } else {
      for (const key of SESSION_RELEVANT_FIELDS) {
        if (sessionRelevantFieldChanged(key, prev[key], state[key])) {
          changedFields.push(key)
        }
      }
    }
    const hasNewRelevantChanges = changedFields.length > 0
    if (!hasNewRelevantChanges && pendingChangedFields.size === 0) {
      return
    }
    if (hasNewRelevantChanges) {
      const next: Record<string, unknown> = {}
      for (const key of SESSION_RELEVANT_FIELDS) {
        next[key] = state[key]
      }
      prev = next
      for (const field of changedFields) {
        pendingChangedFields.add(field)
      }
    }

    if (shouldSchedulePersist && !shouldSchedulePersist()) {
      scheduleFlush(suppressionRetryMs, false)
      return
    }
    scheduleFlush(debounceMs, hasNewRelevantChanges)
  })

  return () => {
    disposed = true
    unsub()
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pendingChangedFields.clear()
  }
}
