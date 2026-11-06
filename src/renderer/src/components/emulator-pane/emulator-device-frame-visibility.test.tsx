// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmulatorDeviceFrame } from './emulator-device-frame'
import { resetStaleDocumentVisibilityForTesting } from '../terminal-pane/stale-document-visibility'
import { EMULATOR_STREAM_PARK_DELAY_MS } from './use-emulator-stream-window-visibility'

// Assert source stream IPC: inactive panes must avoid frame delivery/blob churn/decoding while keeping the session attached.

type FrameListener = (data: { streamId: string; bytes: ArrayBuffer }) => void
type ErrorListener = (data: { streamId: string; message: string }) => void

let container: HTMLDivElement
let root: Root
let startFrameStream: ReturnType<typeof vi.fn>
let stopFrameStream: ReturnType<typeof vi.fn>
let streamCounter: number

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  streamCounter = 0
  startFrameStream = vi.fn(async () => ({ streamId: `stream-${++streamCounter}` }))
  stopFrameStream = vi.fn(async () => {})
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:emulator-frame')
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      emulator: {
        startFrameStream,
        stopFrameStream,
        onFrameStreamFrame: (_listener: FrameListener) => () => {},
        onFrameStreamError: (_listener: ErrorListener) => () => {}
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  delete (URL as Partial<typeof URL>).createObjectURL
  delete (URL as Partial<typeof URL>).revokeObjectURL
  delete (window as { api?: unknown }).api
  setDocumentVisibility('visible')
  resetStaleDocumentVisibilityForTesting()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function renderFrame(isActive: boolean): Promise<void> {
  await act(async () => {
    root.render(
      <EmulatorDeviceFrame
        previewUrl="http://127.0.0.1:3100/stream.mjpeg"
        wsUrl="ws://127.0.0.1:3100/ws"
        loading={false}
        isLive={true}
        visualOrientation="portrait"
        isActive={isActive}
        onTap={vi.fn()}
        onGesture={vi.fn()}
      />
    )
  })
}

describe('EmulatorDeviceFrame visibility gating', () => {
  it('tears the stream down when the pane becomes inactive and resumes when active again', async () => {
    await renderFrame(true)
    expect(startFrameStream).toHaveBeenCalledTimes(1)

    await renderFrame(false)
    expect(stopFrameStream).toHaveBeenCalledWith({ streamId: 'stream-1' })

    await renderFrame(true)
    expect(startFrameStream).toHaveBeenCalledTimes(2)
  })
})

describe('EmulatorDeviceFrame window-visibility gating', () => {
  it('parks the stream after the window stays hidden past the park delay, and resumes when visible', async () => {
    vi.useFakeTimers()
    await renderFrame(true)
    expect(startFrameStream).toHaveBeenCalledTimes(1)

    // A short park grace prevents stream teardown on quick window switches.
    await act(async () => {
      setDocumentVisibility('hidden')
    })
    expect(stopFrameStream).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(EMULATOR_STREAM_PARK_DELAY_MS)
    })
    expect(stopFrameStream).toHaveBeenCalledWith({ streamId: 'stream-1' })

    await act(async () => {
      setDocumentVisibility('visible')
    })
    expect(startFrameStream).toHaveBeenCalledTimes(2)
  })

  it('does not tear down on a quick hide/show within the park delay', async () => {
    vi.useFakeTimers()
    await renderFrame(true)
    expect(startFrameStream).toHaveBeenCalledTimes(1)

    await act(async () => {
      setDocumentVisibility('hidden')
    })
    await act(async () => {
      vi.advanceTimersByTime(EMULATOR_STREAM_PARK_DELAY_MS - 100)
    })
    await act(async () => {
      setDocumentVisibility('visible')
    })
    // Returning before the grace expires must cancel parking without reconnecting.
    await act(async () => {
      vi.advanceTimersByTime(EMULATOR_STREAM_PARK_DELAY_MS)
    })
    expect(stopFrameStream).not.toHaveBeenCalled()
    expect(startFrameStream).toHaveBeenCalledTimes(1)
  })

  it('keeps streaming while hidden when occlusion state is proven stale (display-sleep wedge)', async () => {
    vi.useFakeTimers()
    await renderFrame(true)
    expect(startFrameStream).toHaveBeenCalledTimes(1)

    // Real input disproves a wedged hidden/occluded signal; streaming must continue instead of leaving a black frame.
    await act(async () => {
      setDocumentVisibility('hidden')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(EMULATOR_STREAM_PARK_DELAY_MS * 2)
    })
    expect(stopFrameStream).not.toHaveBeenCalled()
    expect(startFrameStream).toHaveBeenCalledTimes(1)
  })

  it('resumes a parked stream when user input proves hidden visibility is stale', async () => {
    vi.useFakeTimers()
    await renderFrame(true)

    await act(async () => setDocumentVisibility('hidden'))
    await act(async () => vi.advanceTimersByTime(EMULATOR_STREAM_PARK_DELAY_MS))
    expect(stopFrameStream).toHaveBeenCalledWith({ streamId: 'stream-1' })

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(document.visibilityState).toBe('hidden')
    expect(startFrameStream).toHaveBeenCalledTimes(2)
  })
})
