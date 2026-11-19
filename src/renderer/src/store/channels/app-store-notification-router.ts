import type { AppState } from '../types'

type Listener = (state: AppState, previousState: AppState) => void
type Subscription = { listener: Listener }

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
  innerSubscribe: (listener: Listener) => () => void,
  getState: () => AppState,
  options: {
    skipRootSelectorsOnChannelOnlyWrites: boolean
    afterSkippedDispatch?: (state: AppState, previousState: AppState) => void
  }
) {
  const all = new Set<Subscription>()
  const rootSelectors = new Set<Subscription>()
  // Same order as `all`, minus root selectors: a channel-only write never walks those.
  const others = new Set<Subscription>()
  let nextWriteChannelOnly = false

  // Live sets and a fresh state per listener, as the store's own Set.forEach dispatch does:
  // listeners added mid-dispatch still hear this write, and a nested write's state reaches later ones.
  innerSubscribe((state, previousState) => {
    const skipRootSelectors = nextWriteChannelOnly && options.skipRootSelectorsOnChannelOnlyWrites
    nextWriteChannelOnly = false
    ;(skipRootSelectors ? others : all).forEach((subscription) => {
      try {
        subscription.listener(getState(), previousState)
      } catch (error) {
        console.error('Store observer failed', error)
      }
    })
    if (skipRootSelectors) {
      options.afterSkippedDispatch?.(state, previousState)
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
