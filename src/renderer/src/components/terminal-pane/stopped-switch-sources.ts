import { useAppStore } from '@/store'
import type { StoppedSwitchSource } from '../../../../shared/stopped-switch-source'

/**
 * Main's word that a switch stopped this exact pane's process and no replace removed it. Held per
 * leaf only while that leaf still shows that process, so a closed, rebound or successor pane
 * drops it; a pane that is parked when it arrives takes it when it mounts.
 */
const sources = new Map<string, StoppedSwitchSource>()
const watchers = new Map<string, () => void>()
let unsubscribeStore: (() => void) | null = null

const keyOf = (tabId: string, leafId: string): string => `${tabId}:${leafId}`

function stillShown(source: StoppedSwitchSource): boolean {
  const layout = useAppStore.getState().terminalLayoutsByTabId[source.tabId]
  return layout?.ptyIdsByLeafId?.[source.leafId] === source.ptyId
}

/** A switch that put a chat in this tab's slot settles only once that chat is here: by then the
 *  replace's own pass has closed the tab, so a successful switch never shows the exited state. */
function replaceSettled(source: StoppedSwitchSource): boolean {
  const { replacedBySessionId } = source
  return (
    !replacedBySessionId ||
    (useAppStore.getState().unifiedTabsByWorktree[source.worktreeId] ?? []).some(
      (tab) => tab.contentType === 'agent-session' && tab.entityId === replacedBySessionId
    )
  )
}

function reconcile(): void {
  for (const [key, source] of sources) {
    if (!stillShown(source)) {
      sources.delete(key)
    } else if (replaceSettled(source)) {
      watchers.get(key)?.()
    }
  }
  if (sources.size === 0) {
    unsubscribeStore?.()
    unsubscribeStore = null
  }
}

let reconcileQueued = false
// After the store write that brought the chat: the same pass closes a replaced tab first.
function scheduleReconcile(): void {
  if (reconcileQueued) {
    return
  }
  reconcileQueued = true
  queueMicrotask(() => {
    reconcileQueued = false
    reconcile()
  })
}

export function noteStoppedSwitchSource(source: StoppedSwitchSource): void {
  if (!stillShown(source)) {
    return
  }
  sources.set(keyOf(source.tabId, source.leafId), source)
  unsubscribeStore ??= useAppStore.subscribe(scheduleReconcile)
  scheduleReconcile()
}

/**
 * A pane that kept a stopped process's screen for a replace watches for main's settlement. The
 * callback runs once, for this exact process; the returned function stops watching.
 */
export function watchStoppedSwitchSource(
  pane: { tabId: string; leafId: string; ptyId: string; incarnationId: string | null },
  settle: () => void
): () => void {
  const key = keyOf(pane.tabId, pane.leafId)
  const watcher = (): void => {
    const source = sources.get(key)
    if (
      !source ||
      source.ptyId !== pane.ptyId ||
      (pane.incarnationId && source.incarnationId && source.incarnationId !== pane.incarnationId)
    ) {
      return
    }
    sources.delete(key)
    watchers.delete(key)
    settle()
  }
  watchers.set(key, watcher)
  scheduleReconcile()
  return () => {
    if (watchers.get(key) === watcher) {
      watchers.delete(key)
    }
  }
}

export function resetStoppedSwitchSourcesForTests(): void {
  sources.clear()
  watchers.clear()
  unsubscribeStore?.()
  unsubscribeStore = null
}
