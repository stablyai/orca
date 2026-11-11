// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/viewport/visibility/stale-document-visibility'
import { useWindowStreamVisible, WINDOW_STREAM_PARK_DELAY_MS } from './use-window-stream-visibility'

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useWindowStreamVisible', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setDocumentVisibility('visible')
  })

  afterEach(() => {
    cleanup()
    setDocumentVisibility('visible')
    resetStaleDocumentVisibilityForTesting()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // Stale-visibility evidence must reopen streams when macOS occlusion updates stop.
  it('treats a wedged hidden document as visible once user input disproves it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hook = renderHook(() => useWindowStreamVisible())

    await act(async () => setDocumentVisibility('hidden'))
    await act(async () => vi.advanceTimersByTime(WINDOW_STREAM_PARK_DELAY_MS))
    expect(hook.result.current).toBe(false)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(document.visibilityState).toBe('hidden')
    expect(hook.result.current).toBe(true)
  })
})
