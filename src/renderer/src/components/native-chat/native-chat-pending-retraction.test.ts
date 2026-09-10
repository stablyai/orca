import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendPendingSendCache,
  clearPendingSendCacheForTests,
  readPendingSendCache,
  type NativeChatPendingSend
} from './native-chat-pending'
import {
  clearPendingSendRetractionListenersForTests,
  retractPendingSendCache,
  subscribeToPendingSendRetractions
} from './native-chat-pending-retraction'

const SCOPE = { paneKey: 'pane-1', agent: 'claude' }
const OTHER_SCOPE = { paneKey: 'pane-2', agent: 'claude' }

function echo(id: string): NativeChatPendingSend {
  return { id, text: id, sentAt: 1_000, afterMessageId: null, afterMessageTimestamp: null }
}

afterEach(() => {
  clearPendingSendCacheForTests()
  clearPendingSendRetractionListenersForTests()
})

describe('retractPendingSendCache', () => {
  it('drops only the named echo from the pane cache', () => {
    appendPendingSendCache(SCOPE, echo('a'))
    appendPendingSendCache(SCOPE, echo('b'))

    expect(retractPendingSendCache(SCOPE, 'a').map((entry) => entry.id)).toEqual(['b'])
    expect(readPendingSendCache(SCOPE).map((entry) => entry.id)).toEqual(['b'])
  })

  it('tells every subscriber for the scope, so no view keeps a stale snapshot', () => {
    // The view that issued the send can be unmounted by the time it fails; the
    // view that replaced it holds its own copy of the echo and would otherwise
    // write it back to the cache on its next transcript pass.
    const first = vi.fn()
    const second = vi.fn()
    subscribeToPendingSendRetractions(SCOPE, first)
    subscribeToPendingSendRetractions(SCOPE, second)
    appendPendingSendCache(SCOPE, echo('a'))

    retractPendingSendCache(SCOPE, 'a')

    expect(first).toHaveBeenCalledExactlyOnceWith('a')
    expect(second).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('leaves another pane out of it', () => {
    const other = vi.fn()
    subscribeToPendingSendRetractions(OTHER_SCOPE, other)
    appendPendingSendCache(OTHER_SCOPE, echo('a'))
    appendPendingSendCache(SCOPE, echo('a'))

    retractPendingSendCache(SCOPE, 'a')

    expect(other).not.toHaveBeenCalled()
    expect(readPendingSendCache(OTHER_SCOPE).map((entry) => entry.id)).toEqual(['a'])
  })

  it('stops notifying an unsubscribed listener', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToPendingSendRetractions(SCOPE, listener)
    appendPendingSendCache(SCOPE, echo('a'))
    unsubscribe()

    retractPendingSendCache(SCOPE, 'a')

    expect(listener).not.toHaveBeenCalled()
  })

  it('survives a listener that unsubscribes while being notified', () => {
    // A retraction can unmount the surface that was showing the echo.
    const second = vi.fn()
    const unsubscribeFirst = subscribeToPendingSendRetractions(SCOPE, () => {
      unsubscribeFirst()
    })
    subscribeToPendingSendRetractions(SCOPE, second)

    retractPendingSendCache(SCOPE, 'a')

    expect(second).toHaveBeenCalledExactlyOnceWith('a')
  })
})
