// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopAppCapture } from './use-desktop-app-capture'

const prepareCapture = vi.fn(async () => ({ sourceId: 'window:1:0' }))
const releaseCapture = vi.fn(async () => undefined)

function fakeStream() {
  const track = { stop: vi.fn(), addEventListener: vi.fn() }
  return { getTracks: () => [track], getVideoTracks: () => [track], track }
}

describe('useDesktopAppCapture', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      value: { desktopApp: { prepareCapture, releaseCapture } },
      configurable: true
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn(async () => fakeStream()) },
      configurable: true
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('releases the window when the pane stops showing it', async () => {
    const { result, unmount } = renderHook(() =>
      useDesktopAppCapture({ windowId: 1, pid: 42 }, true)
    )
    await waitFor(() => expect(result.current.stream).not.toBeNull())
    unmount()
    expect(releaseCapture).toHaveBeenCalledWith({ windowId: 1, pid: 42 })
  })

  it('releases a prepare that finishes after the pane went away', async () => {
    let finishPrepare: () => void = () => undefined
    prepareCapture.mockImplementationOnce(
      () => new Promise((resolve) => (finishPrepare = () => resolve({ sourceId: 'window:1:0' })))
    )
    const { unmount } = renderHook(() => useDesktopAppCapture({ windowId: 1, pid: 42 }, true))
    await waitFor(() => expect(prepareCapture).toHaveBeenCalled())
    unmount()
    expect(releaseCapture).not.toHaveBeenCalled()
    await act(async () => finishPrepare())
    expect(releaseCapture).toHaveBeenCalledTimes(1)
    expect(navigator.mediaDevices.getDisplayMedia).not.toHaveBeenCalled()
  })

  it('drops the previous stream as soon as the target changes', async () => {
    const { result, rerender } = renderHook(
      ({ windowId }) => useDesktopAppCapture({ windowId, pid: 42 }, true),
      { initialProps: { windowId: 1 } }
    )
    await waitFor(() => expect(result.current.stream).not.toBeNull())
    prepareCapture.mockImplementationOnce(() => new Promise(() => undefined))
    rerender({ windowId: 2 })
    expect(result.current.stream).toBeNull()
    expect(releaseCapture).toHaveBeenCalledWith({ windowId: 1, pid: 42 })
  })
})
