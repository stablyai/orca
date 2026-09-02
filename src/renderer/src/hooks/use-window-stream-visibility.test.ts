// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
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

  it('parks only after the grace period elapses', async () => {
    const hook = renderHook(() => useWindowStreamVisible())
    expect(hook.result.current).toBe(true)

    await act(async () => setDocumentVisibility('hidden'))
    await act(async () => vi.advanceTimersByTime(WINDOW_STREAM_PARK_DELAY_MS - 1))
    expect(hook.result.current).toBe(true)

    await act(async () => vi.advanceTimersByTime(1))
    expect(hook.result.current).toBe(false)
  })

  // Pins the `|| isDocumentVisibilityProvenStale()` term: dropping it wedges every stream pane
  // hidden forever whenever macOS stops reporting occlusion changes.
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

  it('does not report visible while mounted into a hidden window', async () => {
    setDocumentVisibility('hidden')
    const hook = renderHook(() => useWindowStreamVisible())
    expect(hook.result.current).toBe(false)

    await act(async () => setDocumentVisibility('visible'))
    expect(hook.result.current).toBe(true)
  })
})
