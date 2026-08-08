// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeBrowserFocusRequest,
  createAgentInputFocusBorrow,
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  queueBrowserFocusRequest,
  requestBrowserFocus
} from './browser-focus'

describe('browser-focus', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues and consumes one browser focus request per page id', () => {
    queueBrowserFocusRequest({ pageId: 'page-1', target: 'webview' })

    expect(consumeBrowserFocusRequest('page-1')).toBe('webview')
    expect(consumeBrowserFocusRequest('page-1')).toBeNull()
  })

  it('requestBrowserFocus queues and dispatches the focus event', () => {
    const detail = { pageId: 'page-req', target: 'address-bar' as const }
    const events: CustomEvent[] = []
    const onFocusRequest = (event: Event): void => {
      events.push(event as CustomEvent)
    }
    window.addEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, onFocusRequest)
    requestBrowserFocus(detail)
    window.removeEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, onFocusRequest)

    expect(consumeBrowserFocusRequest('page-req')).toBe('address-bar')
    expect(events[0]?.detail).toEqual(detail)
  })

  it('overwrites older requests for the same page id', () => {
    queueBrowserFocusRequest({ pageId: 'page-2', target: 'webview' })
    queueBrowserFocusRequest({ pageId: 'page-2', target: 'address-bar' })

    expect(consumeBrowserFocusRequest('page-2')).toBe('address-bar')
  })

  it('returns null for a page id that was never queued', () => {
    expect(consumeBrowserFocusRequest('nonexistent-page')).toBeNull()
  })

  it('expires unconsumed requests for pages that never mount', () => {
    vi.useFakeTimers()

    queueBrowserFocusRequest({ pageId: 'page-stale', target: 'webview' })

    vi.advanceTimersByTime(30_000)

    expect(consumeBrowserFocusRequest('page-stale')).toBeNull()
  })
})

describe('createAgentInputFocusBorrow', () => {
  function makeBorrow(focusSucceeds = true) {
    const owner = { id: 'terminal-input' }
    const calls: string[] = []
    let captured = 0
    const borrow = createAgentInputFocusBorrow<typeof owner>({
      captureOwner: () => {
        captured += 1
        // Why: mirrors the pane — once the guest holds focus there is no prior owner
        // left to capture, so a nested begin would record null.
        return captured === 1 ? owner : null
      },
      focusGuest: () => {
        calls.push('focus-guest')
        return focusSucceeds
      },
      restore: (o) => calls.push(`restore:${o ? o.id : 'null'}`)
    })
    return { borrow, calls }
  }

  it('returns focus to the original owner for a single borrow', () => {
    const { borrow, calls } = makeBorrow()

    borrow('begin')
    borrow('end')

    expect(calls).toEqual(['focus-guest', 'restore:terminal-input'])
  })

  it('restores the outermost owner when borrows nest', () => {
    const { borrow, calls } = makeBorrow()

    // A single typed character: keyDown/char/keyUp each announce their own pair.
    borrow('begin')
    borrow('begin')
    borrow('begin')
    borrow('end')
    borrow('end')
    borrow('end')

    expect(calls.filter((c) => c.startsWith('restore'))).toEqual(['restore:terminal-input'])
  })

  it('does not restore while an inner borrow is still open', () => {
    const { borrow, calls } = makeBorrow()

    borrow('begin')
    borrow('begin')
    borrow('end')

    expect(calls.some((c) => c.startsWith('restore'))).toBe(false)
  })

  it('ignores an unmatched end so the next borrow still restores', () => {
    const { borrow, calls } = makeBorrow()

    // A command already in flight when the listener mounted.
    borrow('end')
    calls.length = 0

    borrow('begin')
    borrow('end')

    expect(calls).toEqual(['focus-guest', 'restore:terminal-input'])
  })

  // Why: main forwards the input only once the pane confirms the guest took focus.
  it('reports whether the guest actually took focus', () => {
    expect(makeBorrow(true).borrow('begin')).toBe(true)
    expect(makeBorrow(false).borrow('begin')).toBe(false)
  })

  it('still unwinds a borrow whose focus failed', () => {
    const { borrow, calls } = makeBorrow(false)

    borrow('begin')
    borrow('end')
    calls.length = 0

    // Why: a failed begin that skipped the count would strand the depth above zero and
    // swallow every later restore.
    borrow('begin')
    borrow('end')

    expect(calls).toEqual(['focus-guest', 'restore:null'])
  })
})
