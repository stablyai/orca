import { useAppStore } from '@/store'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { rimForAgentState } from '@/lib/agent-rim'
import { makePaneKey } from '../../../../shared/stable-pane-id'

// Mirrors terminal-pane-attention-subscriptions.ts, keyed off agent status; terminal.css paints `.pane[data-agent-rim]`.

type Listener = () => void
type StoreState = ReturnType<typeof useAppStore.getState>

const listenersByTabId = new Map<string, Set<Listener>>()
let unsubscribeStore: (() => void) | null = null
let prevStatus: StoreState['agentStatusByPaneKey'] | null = null
let prevCompletion: StoreState['unreadAgentCompletionPanes'] | null = null

function tabIdFromPaneKey(paneKey: string): string | null {
  const delimiter = paneKey.indexOf(':')
  return delimiter > 0 ? paneKey.slice(0, delimiter) : null
}

// Collect only the tabs whose rim result changed across the two store maps,
// so unaffected tabs never re-apply.
function collectChangedTabs(
  prevStatusMap: StoreState['agentStatusByPaneKey'],
  nextStatusMap: StoreState['agentStatusByPaneKey'],
  prevCompletionMap: StoreState['unreadAgentCompletionPanes'],
  nextCompletionMap: StoreState['unreadAgentCompletionPanes']
): Set<string> {
  const changed = new Set<string>()
  const paneKeys = new Set<string>([
    ...Object.keys(prevStatusMap),
    ...Object.keys(nextStatusMap),
    ...Object.keys(prevCompletionMap),
    ...Object.keys(nextCompletionMap)
  ])
  for (const paneKey of paneKeys) {
    const prevEntry = prevStatusMap[paneKey]
    const nextEntry = nextStatusMap[paneKey]
    const before = rimForAgentState(
      prevEntry?.state,
      Boolean(prevEntry?.interrupted),
      Boolean(prevCompletionMap[paneKey])
    )
    const after = rimForAgentState(
      nextEntry?.state,
      Boolean(nextEntry?.interrupted),
      Boolean(nextCompletionMap[paneKey])
    )
    if (before !== after) {
      const tabId = tabIdFromPaneKey(paneKey)
      if (tabId) {
        changed.add(tabId)
      }
    }
  }
  return changed
}

function notifyTab(tabId: string): void {
  const listeners = listenersByTabId.get(tabId)
  if (!listeners) {
    return
  }
  for (const listener of Array.from(listeners)) {
    listener()
  }
}

function ensureStoreSubscription(): void {
  if (unsubscribeStore !== null) {
    return
  }
  const initial = useAppStore.getState()
  prevStatus = initial.agentStatusByPaneKey
  prevCompletion = initial.unreadAgentCompletionPanes
  unsubscribeStore = useAppStore.subscribe((state) => {
    const nextStatus = state.agentStatusByPaneKey
    const nextCompletion = state.unreadAgentCompletionPanes
    if (nextStatus === prevStatus && nextCompletion === prevCompletion) {
      return
    }
    const changed = collectChangedTabs(
      prevStatus ?? {},
      nextStatus,
      prevCompletion ?? {},
      nextCompletion
    )
    prevStatus = nextStatus
    prevCompletion = nextCompletion
    for (const tabId of changed) {
      notifyTab(tabId)
    }
  })
}

export function subscribeAgentPaneRim(tabId: string, listener: Listener): () => void {
  ensureStoreSubscription()
  let listeners = listenersByTabId.get(tabId)
  if (!listeners) {
    listeners = new Set()
    listenersByTabId.set(tabId, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = listenersByTabId.get(tabId)
    if (!current) {
      return
    }
    current.delete(listener)
    if (current.size === 0) {
      listenersByTabId.delete(tabId)
    }
    if (listenersByTabId.size === 0 && unsubscribeStore !== null) {
      unsubscribeStore()
      unsubscribeStore = null
      prevStatus = null
      prevCompletion = null
    }
  }
}

export function applyAgentPaneRimToManager(manager: PaneManager, tabId: string): void {
  const state = useAppStore.getState()
  const statusByPaneKey = state.agentStatusByPaneKey
  const completionByPaneKey = state.unreadAgentCompletionPanes
  for (const pane of manager.getPanes()) {
    const paneKey = makePaneKey(tabId, pane.leafId)
    const entry = statusByPaneKey[paneKey]
    const rim = rimForAgentState(
      entry?.state,
      Boolean(entry?.interrupted),
      Boolean(completionByPaneKey[paneKey])
    )
    if (rim) {
      pane.container.setAttribute('data-agent-rim', rim)
    } else {
      pane.container.removeAttribute('data-agent-rim')
    }
  }
}

export function resetAgentPaneRimSubscriptionsForTests(): void {
  unsubscribeStore?.()
  unsubscribeStore = null
  listenersByTabId.clear()
  prevStatus = null
  prevCompletion = null
}
