// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmulatorScreenStreamContent } from './emulator-screen-stream-content'

type FrameListener = (data: { streamId: string; bytes: ArrayBuffer }) => void
type ErrorListener = (data: { streamId: string; message: string }) => void

let container: HTMLDivElement
let root: Root
let frameListeners: FrameListener[]
let errorListeners: ErrorListener[]
let startFrameStream: ReturnType<typeof vi.fn>
let stopFrameStream: ReturnType<typeof vi.fn>
let originalCreateObjectURL: typeof URL.createObjectURL | undefined
let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined
let objectUrlCounter: number
let streamCounter: number

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  frameListeners = []
  errorListeners = []
  objectUrlCounter = 0
  streamCounter = 0
  startFrameStream = vi.fn(async () => ({ streamId: `stream-${++streamCounter}` }))
  stopFrameStream = vi.fn(async () => {})
  originalCreateObjectURL = URL.createObjectURL
  originalRevokeObjectURL = URL.revokeObjectURL
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:emulator-frame-${++objectUrlCounter}`)
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn()
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      emulator: {
        startFrameStream,
        stopFrameStream,
        onFrameStreamFrame: (listener: FrameListener) => {
          frameListeners.push(listener)
          return () => {
            frameListeners = frameListeners.filter((current) => current !== listener)
          }
        },
        onFrameStreamError: (listener: ErrorListener) => {
          errorListeners.push(listener)
          return () => {
            errorListeners = errorListeners.filter((current) => current !== listener)
          }
        }
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
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL
    })
  } else {
    delete (URL as Partial<typeof URL>).createObjectURL
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectURL
    })
  } else {
    delete (URL as Partial<typeof URL>).revokeObjectURL
  }
  delete (window as { api?: unknown }).api
  vi.restoreAllMocks()
})

async function renderStream(streamKey = 'abc'): Promise<void> {
  await act(async () => {
    root.render(
      <EmulatorScreenStreamContent
        loading={false}
        onStreamError={vi.fn()}
        onStreamSize={vi.fn()}
        previewUrl="http://127.0.0.1:3100/stream.mjpeg"
        showStream={true}
        streamError={false}
        streamKey={streamKey}
      />
    )
  })
}

describe('EmulatorScreenStreamContent', () => {
  it('renders IPC-delivered frames as blob URLs instead of loading the MJPEG URL directly', async () => {
    await renderStream()

    expect(startFrameStream).toHaveBeenCalledWith({
      streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
      streamKey: 'abc'
    })
    expect(container.querySelector('img')).toBeNull()

    await act(async () => {
      frameListeners[0]?.({ streamId: 'stream-1', bytes: new Uint8Array([1, 2, 3]).buffer })
    })

    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('blob:emulator-frame-1')
  })

  it('clears the previous frame while a new stream key is connecting', async () => {
    await renderStream('a')

    await act(async () => {
      frameListeners[0]?.({ streamId: 'stream-1', bytes: new Uint8Array([1, 2, 3]).buffer })
    })

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:emulator-frame-1')

    await renderStream('b')

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Connecting emulator…')
    expect(stopFrameStream).toHaveBeenCalledWith({ streamId: 'stream-1' })

    await act(async () => {
      frameListeners[0]?.({ streamId: 'stream-2', bytes: new Uint8Array([4, 5, 6]).buffer })
    })

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:emulator-frame-2')
  })
})
