import type { AppState } from '../types'

type Listener = (state: AppState, previousState: AppState) => void
type Subscription = { listener: Listener }

// Off until every channel reader is migrated and soaked; on, channel-only writes skip root selectors.
const SKIP_ROOT_SELECTORS_ON_CHANNEL_ONLY_WRITES = false

let counts: (() => { rootSelectors: number; all: number }) | null = null

/** Live listener counts: React root selectors, and every listener including them. */
export function readAppStoreListenerCounts(): { rootSelectors: number; all: number } | null {
  return counts?.() ?? null
}

/**
 * Owns the store's listeners so a write can choose who hears it. React root selectors register
 * separately; every other subscriber hears every write. The inner store keeps one dispatcher, so
 * delivery order and re-entrancy match its own listener set.
 */
export function createAppStoreNotificationRouter(
  innerSubscribe: (listener: Listener) => () => void
) {
  const all = new Set<Subscription>()
  const rootSelectors = new Set<Subscription>()
  // Same order as `all`, minus root selectors: a channel-only write never walks those.
  const others = new Set<Subscription>()
  let nextWriteChannelOnly = false

  innerSubscribe((state, previousState) => {
    const skipRootSelectors = nextWriteChannelOnly && SKIP_ROOT_SELECTORS_ON_CHANNEL_ONLY_WRITES
    nextWriteChannelOnly = false
    for (const subscription of Array.from(skipRootSelectors ? others : all)) {
      if (!all.has(subscription)) {
        continue
      }
      try {
        subscription.listener(state, previousState)
      } catch (error) {
        console.error('Store observer failed', error)
      }
    }
  })

  function add(listener: Listener, rootSelector: boolean): () => void {
    const subscription = { listener }
    all.add(subscription)
    ;(rootSelector ? rootSelectors : others).add(subscription)
    return () => {
      all.delete(subscription)
      rootSelectors.delete(subscription)
      others.delete(subscription)
    }
  }

  counts = () => ({ rootSelectors: rootSelectors.size, all: all.size })

  return {
    subscribe: (listener: Listener) => add(listener, false),
    subscribeRootSelector: (listener: () => void) => add(listener, true),
    /** Call immediately before the store write it classifies. */
    classifyNextWrite: (channelOnly: boolean) => {
      nextWriteChannelOnly = channelOnly
    }
  }
}
