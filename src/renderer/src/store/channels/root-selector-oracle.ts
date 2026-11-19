import { useLayoutEffect, useState } from 'react'
import type { AppState } from '../types'
import { isAppStoreChannelField, type RootSelectorState } from './app-store-channels'

type Selector = (state: RootSelectorState) => unknown

// Committed root selectors only, keyed by a per-hook token so the hook never mutates its own state.
const committed = new Map<object, Selector>()
// At most one pass per interval, a bounded slice per pass: costs stay flat as mounted selectors grow,
// and successive passes walk the whole registry.
const CHECK_INTERVAL_MS = 1000
const CHECK_BUDGET = 200
let nextCheckAt = 0
let cursor: Iterator<Selector> | null = null

/** Development only: records each mounted root selector at commit. */
export function useRecordedRootSelection(selector: Selector): void {
  const [token] = useState(() => ({}))
  // Commit time, not render: a render React discards must not replace what is on screen.
  useLayoutEffect(() => {
    committed.set(token, selector)
    return () => {
      committed.delete(token)
    }
  })
}

/**
 * After a channel-only write skipped root selectors: runs committed selectors on a view of the state
 * that notes any channel field read. Old and new channel handles can share live rows, so comparing
 * results across the write cannot see those reads.
 */
export function checkSkippedRootSelectors(state: AppState): void {
  const now = performance.now()
  if (now < nextCheckAt) {
    return
  }
  nextCheckAt = now + CHECK_INTERVAL_MS
  let channelRead = false
  const watched = new Proxy(state, {
    get(target, key, receiver) {
      if (isAppStoreChannelField(key)) {
        channelRead = true
      }
      return Reflect.get(target, key, receiver)
    }
  })
  for (let checked = 0; checked < CHECK_BUDGET; checked++) {
    cursor ??= committed.values()
    const next = cursor.next()
    if (next.done) {
      cursor = null
      return
    }
    const selector = next.value
    channelRead = false
    try {
      selector(watched)
    } catch {
      continue
    }
    if (channelRead) {
      console.error(
        'A root app-store selector read a channel field; read channel fields through useAppStoreWithChannels.',
        selector
      )
    }
  }
}
