import { useCallback, useContext, useLayoutEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionOwnerForTab
} from '@/runtime/structured-agent-session-owner'
import { selectIdsBeyondHotRetain } from '../terminal-pane/terminal-hidden-view-parking'
import {
  NativeChatViewIdentity,
  nativeChatViewIdentities,
  retireNativeChatViewState
} from './native-chat-view-state-memory'

export const NATIVE_CHAT_COLD_PARK_DELAY_MS = 30_000
export const NATIVE_CHAT_HOT_RETAIN_MS = 300_000
export const NATIVE_CHAT_HOT_RETAIN_LIMIT = 6
type View = {
  visible: boolean
  hiddenSinceMs: number | null
  lastActivatedSeq: number
  leases: number
}
const views = new Map<string, View>()
const tabKeys = new Map<string, string>()
const listeners = new Map<string, Set<() => void>>()
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined
let scheduled = false
export function nativeChatViewKey(tabId: string, host: string | null, sessionId: string): string {
  return JSON.stringify([tabId, host, sessionId])
}
function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) {
    listener()
  }
}
function schedule(): void {
  if (!scheduled) {
    scheduled = true
    queueMicrotask(recompute)
  }
}
function recompute(): void {
  scheduled = false
  clearTimeout(timer)
  const nowMs = Date.now()
  const eligible = [...views].flatMap(([id, view]) =>
    !view.visible &&
    !view.leases &&
    view.hiddenSinceMs !== null &&
    nowMs - view.hiddenSinceMs >= NATIVE_CHAT_COLD_PARK_DELAY_MS
      ? [{ id, hiddenSinceMs: view.hiddenSinceMs, lastActivatedSeq: view.lastActivatedSeq }]
      : []
  )
  const parked = selectIdsBeyondHotRetain(eligible, {
    nowMs,
    hotRetainMs: NATIVE_CHAT_HOT_RETAIN_MS,
    hotRetainLimit: NATIVE_CHAT_HOT_RETAIN_LIMIT
  })
  for (const id of parked) {
    views.delete(id)
    notify(id)
  }
  let deadline = Infinity
  for (const view of views.values()) {
    if (view.visible || view.leases || view.hiddenSinceMs === null) {
      continue
    }
    const age = nowMs - view.hiddenSinceMs
    const delay =
      age < NATIVE_CHAT_COLD_PARK_DELAY_MS
        ? NATIVE_CHAT_COLD_PARK_DELAY_MS
        : NATIVE_CHAT_HOT_RETAIN_MS
    if (age < delay) {
      deadline = Math.min(deadline, view.hiddenSinceMs + delay)
    }
  }
  if (Number.isFinite(deadline)) {
    timer = setTimeout(schedule, Math.max(1, deadline - nowMs))
  }
}
const ownerInputs = [
  'repos',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds'
] as const satisfies readonly (keyof WorktreeRuntimeOwnerState)[]
let retirementScheduled = false
let watching = false
function watchRetirement(): void {
  if (watching) {
    return
  }
  watching = true
  useAppStore.subscribe((state, previous) => {
    const changedWorkspaceHost =
      (state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId) &&
      [state.activeWorktreeId, previous.activeWorktreeId].some(
        (id) =>
          id &&
          resolveStructuredAgentSessionOwner(state, id) !==
            resolveStructuredAgentSessionOwner(previous, id)
      )
    if (
      !changedWorkspaceHost &&
      state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree &&
      ownerInputs.every((key) => state[key] === previous[key])
    ) {
      return
    }
    if (retirementScheduled) {
      return
    }
    retirementScheduled = true
    // Structural updates retire cold return data as well as the admitted working set.
    queueMicrotask(() => {
      retirementScheduled = false
      const current = useAppStore.getState()
      const identities = new Set<string>()
      for (const tabs of Object.values(current.unifiedTabsByWorktree)) {
        for (const tab of tabs) {
          if (tab.contentType === 'agent-session') {
            identities.add(
              nativeChatViewKey(
                tab.id,
                structuredAgentSessionOwnerForTab(current, tab),
                tab.entityId
              )
            )
          }
        }
      }
      for (const key of nativeChatViewIdentities) {
        if (!identities.has(key)) {
          views.delete(key)
          retireNativeChatViewState(key)
          notify(key)
        }
      }
      for (const [tabId, key] of tabKeys) {
        if (!identities.has(key)) {
          tabKeys.delete(tabId)
        }
      }
      schedule()
    })
  })
}
export function useNativeChatViewAdmission(key: string, tabId: string, visible: boolean): boolean {
  useLayoutEffect(() => {
    watchRetirement()
    let view = views.get(key)
    if (!visible && !view) {
      return
    }
    const oldKey = tabKeys.get(tabId)
    if (oldKey && oldKey !== key) {
      views.delete(oldKey)
      retireNativeChatViewState(oldKey)
      notify(oldKey)
    }
    tabKeys.set(tabId, key)
    nativeChatViewIdentities.add(key)
    if (!view) {
      view = { visible: false, hiddenSinceMs: null, lastActivatedSeq: 0, leases: 0 }
      views.set(key, view)
    }
    if (visible) {
      view.lastActivatedSeq = ++sequence
      view.hiddenSinceMs = null
    } else if (view.visible) {
      view.hiddenSinceMs = Date.now()
    }
    view.visible = visible
    schedule()
    return () => {
      view.visible = false
      view.hiddenSinceMs ??= Date.now()
      schedule()
    }
  }, [key, tabId, visible])
  const subscribe = useCallback(
    (listener: () => void) => {
      const keyed = listeners.get(key) ?? new Set()
      listeners.set(key, keyed)
      keyed.add(listener)
      return () => {
        keyed.delete(listener)
        if (keyed.size === 0) {
          listeners.delete(key)
        }
      }
    },
    [key]
  )
  return useSyncExternalStore(subscribe, () => visible || views.has(key))
}
function holdView(key: string | undefined): () => void {
  const view = key === undefined ? undefined : views.get(key)
  if (!view) {
    return () => {}
  }
  view.leases += 1
  let released = false
  return () => {
    if (!released) {
      released = true
      view.leases -= 1
      schedule()
    }
  }
}
export function useNativeChatViewLease(): () => () => void {
  const key = useContext(NativeChatViewIdentity)
  return useCallback(() => holdView(key?.split('\0')[0]), [key])
}
export function holdNativeChatInput(element: Element | null): () => void {
  const tabId = element
    ?.closest('[data-structured-agent-session-overlay-tab-id]')
    ?.getAttribute('data-structured-agent-session-overlay-tab-id')
  return holdView(tabId ? tabKeys.get(tabId) : undefined)
}
