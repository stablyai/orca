// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmulatorDeviceFrame } from './emulator-device-frame'
import { resetStaleDocumentVisibilityForTesting } from '../terminal-pane/stale-document-visibility'
import { EMULATOR_STREAM_PARK_DELAY_MS } from './use-emulator-stream-window-visibility'

// Why: a backgrounded but still-attached emulator must stop streaming frames.
// The perf contract is that no frame stream is started (no per-frame IPC / MJPEG
// blob churn / H.264 decode) while the pane is inactive, and that a running
// stream is torn down when the pane is hidden — so this asserts the IPC calls,
// not just the rendered DOM.

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
  it('streams frames while the pane is active', async () => {
    await renderFrame(true)
    expect(startFrameStream).toHaveBeenCalledWith(
      expect.objectContaining({ streamUrl: 'http://127.0.0.1:3100/stream.mjpeg' })
    )
  })

  it('does not start a frame stream while the pane is inactive', async () => {
    await renderFrame(false)
    expect(startFrameStream).not.toHaveBeenCalled()
  })

  it('tears the stream down when the pane becomes inactive and resumes when active again', async () => {
    await renderFrame(true)
    expect(startFrameStream).toHaveBeenCalledTimes(1)

    // Parking the pane must stop the stream at the source (no more IPC frames).
    await renderFrame(false)
    expect(stopFrameStream).toHaveBeenCalledWith({ streamId: 'stream-1' })

    // Re-showing re-fires the stream; the session was never detached.
    await renderFrame(true)
    expect(startFrameStream).toHaveBeenCalledTimes(2)
  })
})

describe('EmulatorDeviceFrame window-visibility gating', () => {
  it('parks the stream after the window stays hidden past the park delay, and resumes when visible', async () => {
    vi.useFakeTimers()
    await renderFrame(true)
    expect(startFrameStream).toHaveBeenCalledTimes(1)

    // Hiding the window does not tear down immediately — a short grace covers a
    // quick Cmd+Tab round-trip.
    await act(async () => {
      setDocumentVisibility('hidden')
    })
    expect(stopFrameStream).not.toHaveBeenCalled()

    // Once the grace elapses, the stream parks at the source.
    await act(async () => {
      vi.advanceTimersByTime(EMULATOR_STREAM_PARK_DELAY_MS)
    })
    expect(stopFrameStream).toHaveBeenCalledWith({ streamId: 'stream-1' })

    // Returning to the window resumes immediately; the session was never detached.
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
    // The park timer was cancelled by the return-to-visible, so the stream never
    // stopped and no reconnect was needed.
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

    // Window reports hidden, but real user input proves the occlusion tracker is
    // wedged; the stream must keep running instead of freezing on a black frame.
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
})
