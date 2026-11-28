import { useCallback, useSyncExternalStore } from 'react'

// Why: a hidden chat view holds its transcript DOM, fibers and editor; keeping visited ones grows memory with use.
// A hidden chat's view state is kept per tab instead, so it remounts as the reader left it.
export const RETAINED_HIDDEN_CHAT_VIEWS = 0

const EMPTY: ReadonlySet<string> = new Set()

/**
 * Which chat views stay mounted across the window: every shown chat, and the most recently shown hidden ones
 * within the allowance. Each change notifies only the tabs whose membership changed.
 */
class ChatViewRetention {
  private order: readonly string[] = []
  private shownByLayer = new Map<string, readonly string[]>()
  private retained: ReadonlySet<string> = EMPTY
  private listenersByTab = new Map<string, Set<() => void>>()

  /** A layer reports the chats it shows now; an empty list hides them all. */
  show(layer: string, tabIds: readonly string[]): void {
    if (tabIds.length === 0) {
      this.shownByLayer.delete(layer)
    } else {
      this.shownByLayer.set(layer, tabIds)
      const shown = new Set(tabIds)
      this.order = [...tabIds, ...this.order.filter((id) => !shown.has(id))]
    }
    this.recompute()
  }

  /** A closed tab frees its place for the next chat shown. */
  forget(tabIds: ReadonlySet<string>): void {
    this.order = this.order.filter((id) => !tabIds.has(id))
    this.recompute()
  }

  private recompute(): void {
    const shown = new Set([...this.shownByLayer.values()].flat())
    const hidden = this.order.filter((id) => !shown.has(id)).slice(0, RETAINED_HIDDEN_CHAT_VIEWS)
    // Older hidden entries can never come back into the allowance, so the order stays bounded; a shown one
    // keeps its place for when it hides.
    const kept = new Set(hidden)
    this.order = this.order.filter((id) => shown.has(id) || kept.has(id))
    const next = new Set([...shown, ...hidden])
    const previous = this.retained
    this.retained = next
    const notify = new Set<() => void>()
    for (const id of next) {
      if (!previous.has(id)) {
        this.listenersByTab.get(id)?.forEach((listener) => notify.add(listener))
      }
    }
    for (const id of previous) {
      if (!next.has(id)) {
        this.listenersByTab.get(id)?.forEach((listener) => notify.add(listener))
      }
    }
    notify.forEach((listener) => listener())
  }

  subscribe(tabIds: ReadonlySet<string>, listener: () => void): () => void {
    for (const id of tabIds) {
      let listeners = this.listenersByTab.get(id)
      if (!listeners) {
        listeners = new Set()
        this.listenersByTab.set(id, listeners)
      }
      listeners.add(listener)
    }
    return () => {
      for (const id of tabIds) {
        const listeners = this.listenersByTab.get(id)
        listeners?.delete(listener)
        if (listeners?.size === 0) {
          this.listenersByTab.delete(id)
        }
      }
    }
  }

  /** The retained tabs among `tabIds`, walking only the small retained set. */
  retainedAmong(tabIds: ReadonlySet<string>): string {
    return [...this.retained]
      .filter((id) => tabIds.has(id))
      .sort()
      .join('\n')
  }
}

export const chatViewRetention = new ChatViewRetention()

/** This layer's retained tabs as a stable key; only a change to one of its own tabs wakes it. */
export function useRetainedChatViewKey(ownedTabIds: ReadonlySet<string>): string {
  const subscribe = useCallback(
    (listener: () => void) => chatViewRetention.subscribe(ownedTabIds, listener),
    [ownedTabIds]
  )
  return useSyncExternalStore(subscribe, () => chatViewRetention.retainedAmong(ownedTabIds))
}
