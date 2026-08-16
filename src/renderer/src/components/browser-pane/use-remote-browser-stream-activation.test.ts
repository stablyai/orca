// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '../terminal-pane/stale-document-visibility'
import { WINDOW_STREAM_PARK_DELAY_MS } from '@/hooks/use-window-stream-visibility'
import { useRemoteBrowserStreamActivation } from './use-remote-browser-stream-activation'

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

function renderActivation(isActive = true) {
  const closeStream = vi.fn()
  const open = vi.fn(() => closeStream)
  const lifecycle = { open }
  const clearPendingRemoteWheel = vi.fn()
  const hook = renderHook(
    ({ active }) =>
      useRemoteBrowserStreamActivation({
        activeRuntimeEnvironmentId: 'env-1',
        browserPageId: 'page-1',
        clearPendingRemoteWheel,
        isActive: active,
        lifecycle,
        reopenNonce: 0,
        runtimeWorktree: 'worktree:one'
      }),
    { initialProps: { active: isActive } }
  )
  return { ...hook, clearPendingRemoteWheel, closeStream, open }
}

describe('useRemoteBrowserStreamActivation', () => {
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

  it('parks after the grace period and reopens when stale visibility is disproven', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = renderActivation()
    expect(harness.open).toHaveBeenCalledTimes(1)

    await act(async () => setDocumentVisibility('hidden'))
    await act(async () => vi.advanceTimersByTime(WINDOW_STREAM_PARK_DELAY_MS - 1))
    expect(harness.closeStream).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTime(1))
    expect(harness.closeStream).toHaveBeenCalledTimes(1)
    expect(harness.clearPendingRemoteWheel).toHaveBeenCalledTimes(1)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(document.visibilityState).toBe('hidden')
    expect(harness.open).toHaveBeenCalledTimes(2)
  })

  it('does not reconnect during a quick hide and show', async () => {
    const harness = renderActivation()

    await act(async () => setDocumentVisibility('hidden'))
    await act(async () => vi.advanceTimersByTime(WINDOW_STREAM_PARK_DELAY_MS - 1))
    await act(async () => setDocumentVisibility('visible'))
    await act(async () => vi.advanceTimersByTime(WINDOW_STREAM_PARK_DELAY_MS))

    expect(harness.closeStream).not.toHaveBeenCalled()
    expect(harness.open).toHaveBeenCalledTimes(1)
  })

  it('does not open while mounted hidden', async () => {
    setDocumentVisibility('hidden')
    const harness = renderActivation()
    expect(harness.open).not.toHaveBeenCalled()

    await act(async () => setDocumentVisibility('visible'))
    expect(harness.open).toHaveBeenCalledTimes(1)
  })

  it('parks immediately when its pane becomes inactive', async () => {
    const harness = renderActivation()

    await act(async () => harness.rerender({ active: false }))
    expect(harness.closeStream).toHaveBeenCalledTimes(1)
    expect(harness.clearPendingRemoteWheel).toHaveBeenCalledTimes(1)

    await act(async () => harness.rerender({ active: true }))
    expect(harness.open).toHaveBeenCalledTimes(2)
  })

  // Closing a tab while parked leaves no effect cleanup to run, so unmount must not resurrect the
  // stream when the window comes back — the pane's lifecycle is already disposed by then.
  it('stays closed when its tab is closed while the stream is parked', async () => {
    const harness = renderActivation()

    await act(async () => setDocumentVisibility('hidden'))
    await act(async () => vi.advanceTimersByTime(WINDOW_STREAM_PARK_DELAY_MS))
    expect(harness.closeStream).toHaveBeenCalledTimes(1)

    await act(async () => harness.unmount())
    await act(async () => setDocumentVisibility('visible'))

    expect(harness.open).toHaveBeenCalledTimes(1)
    expect(harness.closeStream).toHaveBeenCalledTimes(1)
  })
})
