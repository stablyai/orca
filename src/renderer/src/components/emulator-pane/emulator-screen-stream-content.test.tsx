// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { EmulatorScreenStreamContent } from './emulator-screen-stream-content'

type FrameListener = (data: { streamId: string; bytes: ArrayBuffer }) => void
type ErrorListener = (data: { streamId: string; message: string }) => void
type VideoFrameListener = (data: {
  streamId: string
  deviceId: string
  config: boolean
  keyFrame: boolean
  seed?: boolean
  bytes: ArrayBuffer
}) => void

const IOS_UDID = '5C1A9A5E-0000-4000-8000-000000000001'
const IOS_PREVIEW_URL = `http://127.0.0.1:3100/helper/${IOS_UDID}/stream.mjpeg`

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = []
  state = 'unconfigured'
  decodeQueueSize = 0
  configs: VideoDecoderConfig[] = []
  chunks: { type: string }[] = []
  resets = 0
  constructor(
    private readonly init: {
      output: (frame: { displayWidth: number; displayHeight: number; close: () => void }) => void
    }
  ) {
    FakeVideoDecoder.instances.push(this)
  }
  configure(config: VideoDecoderConfig): void {
    this.state = 'configured'
    this.configs.push(config)
  }
  decode(chunk: { type: string }): void {
    this.chunks.push(chunk)
    this.init.output({ displayWidth: 1206, displayHeight: 2622, close: () => {} })
  }
  reset(): void {
    this.state = 'unconfigured'
    this.resets += 1
  }
  close(): void {
    this.state = 'closed'
  }
}

let container: HTMLDivElement
let root: Root
let frameListeners: FrameListener[]
let errorListeners: ErrorListener[]
let videoFrameListeners: VideoFrameListener[]
let startFrameStream: ReturnType<typeof vi.fn>
let stopFrameStream: ReturnType<typeof vi.fn>
let startVideoStream: ReturnType<typeof vi.fn>
let stopVideoStream: ReturnType<typeof vi.fn>
let originalCreateObjectURL: typeof URL.createObjectURL | undefined
let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined
let objectUrlCounter: number
let streamCounter: number
let drawImage: Mock

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  frameListeners = []
  errorListeners = []
  videoFrameListeners = []
  FakeVideoDecoder.instances = []
  objectUrlCounter = 0
  streamCounter = 0
  startFrameStream = vi.fn(async () => ({ streamId: `stream-${++streamCounter}` }))
  stopFrameStream = vi.fn(async () => {})
  startVideoStream = vi.fn(async (args: { streamId: string }) => ({ streamId: args.streamId }))
  stopVideoStream = vi.fn(async () => {})
  drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const context: CanvasRenderingContext2D = Object.create(null)
    context.drawImage = drawImage
    context.clearRect = vi.fn()
    return context
  })
  vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
  vi.stubGlobal(
    'EncodedVideoChunk',
    class {
      constructor(init: { type: string }) {
        Object.assign(this, init)
      }
    }
  )
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
        startVideoStream,
        stopVideoStream,
        onVideoStreamMeta: () => () => {},
        onVideoStreamFrame: (listener: VideoFrameListener) => {
          videoFrameListeners.push(listener)
          return () => {
            videoFrameListeners = videoFrameListeners.filter((current) => current !== listener)
          }
        },
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
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function renderStream(
  streamKey = 'abc',
  props?: { screenAspectRatio?: number; streamRotation?: -90 | 0 | 90 }
): Promise<void> {
  await act(async () => {
    root.render(
      <EmulatorScreenStreamContent
        loading={false}
        onStreamError={vi.fn()}
        onStreamSize={vi.fn()}
        previewUrl="http://127.0.0.1:3100/stream.mjpeg"
        screenAspectRatio={props?.screenAspectRatio}
        showStream={true}
        streamError={false}
        streamKey={streamKey}
        streamRotation={props?.streamRotation}
      />
    )
  })
}

async function renderIosStream(onStreamError = vi.fn(), onStreamSize = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(
      <EmulatorScreenStreamContent
        deviceId={IOS_UDID}
        loading={false}
        onStreamError={onStreamError}
        onStreamSize={onStreamSize}
        previewUrl={IOS_PREVIEW_URL}
        showStream={true}
        streamError={false}
        streamKey="ios"
      />
    )
  })
}

function videoStreamId(call: number): string {
  return startVideoStream.mock.calls[call][0].streamId
}

async function sendVideo(
  streamId: string,
  packet: 'config' | 'key' | 'delta' | 'seed'
): Promise<void> {
  await act(async () => {
    for (const listener of videoFrameListeners) {
      listener({
        streamId,
        deviceId: IOS_UDID,
        config: packet === 'config',
        keyFrame: packet === 'key',
        seed: packet === 'seed',
        bytes: new Uint8Array([1, 0x64, 0x00, 0x33]).buffer
      })
    }
  })
}

async function sendStreamError(streamId: string, message: string): Promise<void> {
  await act(async () => {
    for (const listener of errorListeners) {
      listener({ streamId, message })
    }
  })
}

describe('EmulatorScreenStreamContent', () => {
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

  it('streams an iOS simulator as H.264 from its avcC description', async () => {
    await renderIosStream()

    expect(startVideoStream).toHaveBeenCalledWith({
      deviceId: IOS_UDID,
      streamId: videoStreamId(0)
    })
    expect(startFrameStream).not.toHaveBeenCalled()
    await sendVideo(videoStreamId(0), 'config')
    await sendVideo(videoStreamId(0), 'delta')
    await sendVideo(videoStreamId(0), 'key')

    const [decoder] = FakeVideoDecoder.instances
    expect(decoder.configs[0]).toMatchObject({ codec: 'avc1.640033' })
    expect(decoder.chunks.map((chunk) => chunk.type)).toEqual(['key'])
    expect(container.querySelector('canvas')).not.toBeNull()
  })

  it('paints the JPEG seed and reports its size before H.264 arrives', async () => {
    const seed = { width: 400, height: 800, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(seed))
    const onStreamSize = vi.fn()
    await renderIosStream(vi.fn(), onStreamSize)

    await sendVideo(videoStreamId(0), 'seed')

    expect(drawImage).toHaveBeenLastCalledWith(seed, 0, 0)
    expect(container.querySelector('canvas')?.width).toBe(400)
    expect(container.querySelector('canvas')?.height).toBe(800)
    expect(onStreamSize).toHaveBeenLastCalledWith({ width: 400, height: 800 })
    expect(seed.close).toHaveBeenCalledOnce()
    await sendVideo(videoStreamId(0), 'config')
    await sendVideo(videoStreamId(0), 'key')
    expect(drawImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ displayWidth: 1206, displayHeight: 2622 }),
      0,
      0
    )
  })

  it('does not let a late JPEG seed paint over a decoded H.264 frame', async () => {
    const seed = { width: 400, height: 800, close: vi.fn() }
    const pending = Promise.withResolvers<typeof seed>()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => pending.promise)
    )
    await renderIosStream()
    await sendVideo(videoStreamId(0), 'seed')
    await sendVideo(videoStreamId(0), 'config')
    await sendVideo(videoStreamId(0), 'key')

    await act(async () => pending.resolve(seed))

    expect(drawImage).not.toHaveBeenCalledWith(seed, 0, 0)
    expect(seed.close).toHaveBeenCalledOnce()
  })

  it('falls back to the iOS JPEG stream without reporting a disconnect when H.264 fails', async () => {
    const onStreamError = vi.fn()
    await renderIosStream(onStreamError)

    await sendStreamError(videoStreamId(0), 'Simulator video stream returned HTTP 404.')

    expect(startFrameStream).toHaveBeenCalledWith(
      expect.objectContaining({ streamUrl: IOS_PREVIEW_URL })
    )
    expect(container.textContent).toContain('Connecting emulator…')
    await act(async () => {
      frameListeners[0]?.({ streamId: 'stream-1', bytes: new Uint8Array([1, 2, 3]).buffer })
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:emulator-frame-1')
    expect(startVideoStream).toHaveBeenCalledOnce()
    expect(onStreamError).not.toHaveBeenCalled()
  })

  it('restarts from a fresh H.264 keyframe instead of letting decode backlog grow', async () => {
    await renderIosStream()
    await sendVideo(videoStreamId(0), 'config')
    await sendVideo(videoStreamId(0), 'key')
    const [decoder] = FakeVideoDecoder.instances
    decoder.decodeQueueSize = 8

    await sendVideo(videoStreamId(0), 'delta')

    expect(stopVideoStream).toHaveBeenCalledWith({ streamId: videoStreamId(0) })
    expect(startVideoStream).toHaveBeenCalledTimes(2)
    expect(decoder.resets).toBe(1)
    expect(decoder.chunks).toHaveLength(1)

    decoder.decodeQueueSize = 0
    await sendVideo(videoStreamId(0), 'key')
    await sendVideo(videoStreamId(1), 'delta')
    expect(decoder.chunks).toHaveLength(1)
    await sendVideo(videoStreamId(1), 'config')
    await sendVideo(videoStreamId(1), 'key')
    expect(decoder.chunks.map((chunk) => chunk.type)).toEqual(['key', 'key'])
  })
})
