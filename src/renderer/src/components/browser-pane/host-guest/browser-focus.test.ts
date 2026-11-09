// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumeBrowserFocusRequest, queueBrowserFocusRequest } from './browser-focus'

describe('browser-focus', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('expires unconsumed requests for pages that never mount', () => {
    vi.useFakeTimers()

    queueBrowserFocusRequest({ pageId: 'page-stale', target: 'webview' })

    vi.advanceTimersByTime(30_000)

    expect(consumeBrowserFocusRequest('page-stale')).toBeNull()
  })
})
