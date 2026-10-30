// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEmulatorVideoStream } from './use-emulator-video-stream'
import type { StreamSize } from './emulator-device-frame-layout'

type Frame = { displayWidth: number; displayHeight: number; close: () => void }
type Meta = {
  streamId: string
  deviceId: string
  meta: { codecId: string; width: number; height: number }
}

let output: (frame: Frame) => void
let metaListener: (meta: Meta) => void
let streamId: string
let reports: StreamSize[]
let root: Root
let contextDescriptor: PropertyDescriptor | undefined

function Screen() {
  const { canvasRef } = useEmulatorVideoStream('device', 'stream', true, (size) =>
    reports.push(size)
  )
  return <canvas ref={canvasRef} />
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  reports = []
  vi.stubGlobal(
    'VideoDecoder',
    class {
      state = 'unconfigured'
      constructor(init: { output: (frame: Frame) => void }) {
        output = init.output
      }
      close(): void {}
    }
  )
  vi.stubGlobal('EncodedVideoChunk', class {})
  contextDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ clearRect: () => {}, drawImage: () => {} })
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      emulator: {
        startVideoStream: async (args: { streamId: string }) => {
          streamId = args.streamId
          return args
        },
        stopVideoStream: async () => {},
        onVideoStreamMeta: (cb: (meta: Meta) => void) => {
          metaListener = cb
          return () => {}
        }
      }
    }
  })
  root = createRoot(document.createElement('div'))
})

afterEach(() => {
  act(() => root.unmount())
  if (contextDescriptor) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', contextDescriptor)
  } else {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext')
  }
  Reflect.deleteProperty(window, 'api')
  vi.unstubAllGlobals()
})

describe('useEmulatorVideoStream decoded size', () => {
  it('reports decoded frame size changes once after codec metadata', async () => {
    await act(async () => root.render(<Screen />))
    const frame = (): void => output({ displayWidth: 480, displayHeight: 240, close: () => {} })
    act(() => {
      metaListener({
        streamId,
        deviceId: 'device',
        meta: { codecId: 'h264', width: 240, height: 480 }
      })
      frame()
      frame()
      frame()
    })
    expect(reports).toEqual([
      { width: 240, height: 480 },
      { width: 480, height: 240 }
    ])
  })
})
