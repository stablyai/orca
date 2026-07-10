import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumeBrowserFocusRequest, queueBrowserFocusRequest } from './browser-focus'

describe('browser-focus', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues and consumes one browser focus request per page id', () => {
    queueBrowserFocusRequest({ pageId: 'page-1', target: 'webview' })

    expect(consumeBrowserFocusRequest('page-1')).toBe('webview')
    expect(consumeBrowserFocusRequest('page-1')).toBeNull()
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
