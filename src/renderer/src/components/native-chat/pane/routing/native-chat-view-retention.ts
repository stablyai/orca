import { useSyncExternalStore } from 'react'

// Why: a hidden chat view holds its transcript DOM, fibers and editor; keeping every visited one grows memory with use.
export const RETAINED_HIDDEN_CHAT_VIEWS = 3

/** Chat tabs by most recent reveal across the window's workspaces; the shown ones plus a few hidden stay mounted. */
class ChatViewRecency {
  private order: readonly string[] = []
  private listeners = new Set<() => void>()

  reveal(tabIds: readonly string[]): void {
    if (tabIds.every((id, index) => this.order[index] === id)) {
      return
    }
    const revealed = new Set(tabIds)
    this.publish(
      [...tabIds, ...this.order.filter((id) => !revealed.has(id))].slice(
        0,
        tabIds.length + RETAINED_HIDDEN_CHAT_VIEWS
      )
    )
  }

  /** A closed tab frees its place for the next chat shown. */
  forget(tabIds: ReadonlySet<string>): void {
    if (this.order.some((id) => tabIds.has(id))) {
      this.publish(this.order.filter((id) => !tabIds.has(id)))
    }
  }

  private publish(order: readonly string[]): void {
    this.order = order
    for (const listener of this.listeners) {
      listener()
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): readonly string[] => this.order
}

export const chatViewRecency = new ChatViewRecency()

/** This layer's retained tabs as a stable key, so a switch elsewhere re-renders no other workspace's layer. */
export function useRetainedChatViewKey(ownedTabIds: ReadonlySet<string>): string {
  return useSyncExternalStore(chatViewRecency.subscribe, () =>
    chatViewRecency
      .snapshot()
      .filter((id) => ownedTabIds.has(id))
      .join('\n')
  )
}
