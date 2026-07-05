// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmulatorDeviceFrame } from './emulator-device-frame'

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
  vi.restoreAllMocks()
})

async function renderFrame(isActive: boolean): Promise<void> {
  await act(async () => {
    root.render(
      <EmulatorDeviceFrame
        previewUrl="http://127.0.0.1:3100/stream.mjpeg"
        wsUrl="ws://127.0.0.1:3100/ws"
        loading={false}
        isLive={true}
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
