// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { EmulatorScreenStreamContent } from './emulator-screen-stream-content'
import { createEmulatorApi } from '../../web/preload-api/web-browser-api'
import { withFallback } from '../../web/preload-api/web-fallback-api'
import type {
  EmulatorVideoStreamErrorMessage,
  EmulatorVideoStreamFrameMessage,
  EmulatorVideoStreamStartArgs
} from '../../../../shared/emulator-video-stream'

type FrameListener = (data: { streamId: string; bytes: ArrayBuffer }) => void
type ErrorListener = (data: { streamId: string; message: string }) => void
type VideoErrorListener = (data: EmulatorVideoStreamErrorMessage) => void
type VideoFrameListener = (data: EmulatorVideoStreamFrameMessage) => void
type StreamProps = ComponentProps<typeof EmulatorScreenStreamContent>
type DecodedFrame = { displayWidth: number; displayHeight: number; close: () => void }
type SeedBitmap = { width: number; height: number; close: () => void }
type VideoChunk = { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }

const IOS_VIDEO = {
  deviceId: 'ios-device',
  avccStreamUrl: 'http://127.0.0.1:3100/stream.avcc'
}
const AVCC_CONFIG = new Uint8Array([
  1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0x80
])

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
let videoErrorListeners: VideoErrorListener[]
let videoFrameListeners: VideoFrameListener[]
let startVideoStream: ReturnType<typeof vi.fn>
let stopVideoStream: ReturnType<typeof vi.fn>
let configureDecoder: ReturnType<typeof vi.fn>
let closeDecoder: ReturnType<typeof vi.fn>
let decodeChunk: Mock<(chunk: VideoChunk) => void>
let resetDecoder: Mock<() => void>
let decoderOutput: (frame: DecodedFrame) => void
let drawImage: Mock<(image: DecodedFrame | SeedBitmap, x: number, y: number) => void>
let decoderError: (error: DOMException) => void
let onStreamError: Mock<() => void>
let videoStreamId: string
let contextDescriptor: PropertyDescriptor | undefined

class TestVideoDecoder {
  state = 'unconfigured'
  configure = configureDecoder
  close = closeDecoder
  reset = resetDecoder
  decode = decodeChunk

  constructor(init: {
    output: (frame: DecodedFrame) => void
    error: (error: DOMException) => void
  }) {
    decoderOutput = init.output
    decoderError = init.error
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  frameListeners = []
  errorListeners = []
  objectUrlCounter = 0
  streamCounter = 0
  videoErrorListeners = []
  videoFrameListeners = []
  onStreamError = vi.fn()
  configureDecoder = vi.fn()
  closeDecoder = vi.fn()
  decodeChunk = vi.fn<(chunk: VideoChunk) => void>()
  resetDecoder = vi.fn()
  drawImage = vi.fn()
  startVideoStream = vi.fn(async (args: EmulatorVideoStreamStartArgs) => {
    videoStreamId = args.streamId
    return { streamId: videoStreamId }
  })
  stopVideoStream = vi.fn(async () => {})
  vi.stubGlobal('VideoDecoder', TestVideoDecoder)
  vi.stubGlobal(
    'EncodedVideoChunk',
    class {
      readonly type: VideoChunk['type']
      readonly timestamp: number
      readonly data: Uint8Array

      constructor(init: VideoChunk) {
        this.type = init.type
        this.timestamp = init.timestamp
        this.data = init.data
      }
    }
  )
  contextDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ clearRect: () => {}, drawImage })
  })
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
        },
        startVideoStream,
        stopVideoStream,
        onVideoStreamMeta: () => () => {},
        onVideoStreamFrame: (listener: VideoFrameListener) => {
          videoFrameListeners.push(listener)
          return () => {
            videoFrameListeners = videoFrameListeners.filter((current) => current !== listener)
          }
        },
        onVideoStreamError: (listener: VideoErrorListener) => {
          videoErrorListeners.push(listener)
          return () => {
            videoErrorListeners = videoErrorListeners.filter((current) => current !== listener)
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
  if (contextDescriptor) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', contextDescriptor)
  } else {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext')
  }
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function renderStream(streamKey = 'abc', props?: Partial<StreamProps>): Promise<void> {
  await act(async () => {
    root.render(
      <EmulatorScreenStreamContent
        loading={false}
        onStreamError={onStreamError}
        onStreamSize={vi.fn()}
        previewUrl="http://127.0.0.1:3100/stream.mjpeg"
        showStream={true}
        streamError={false}
        streamKey={streamKey}
        {...props}
      />
    )
  })
}

function emitVideoFrame(
  bytes: Uint8Array<ArrayBuffer>,
  flags: Partial<Pick<EmulatorVideoStreamFrameMessage, 'config' | 'keyFrame' | 'seed'>> = {},
  deviceId = IOS_VIDEO.deviceId
): void {
  act(() => {
    for (const listener of videoFrameListeners) {
      listener({
        streamId: videoStreamId,
        deviceId,
        config: false,
        keyFrame: false,
        bytes: bytes.buffer,
        ...flags
      })
    }
  })
}

describe('EmulatorScreenStreamContent', () => {
  it('renders IPC-delivered frames as blob URLs instead of loading the MJPEG URL directly', async () => {
    await renderStream('abc', { deviceId: IOS_VIDEO.deviceId })

    expect(startFrameStream).toHaveBeenCalledWith({
      streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
      streamKey: 'abc'
    })
    expect(startVideoStream).not.toHaveBeenCalled()
    expect(container.querySelector('img')).toBeNull()

    await act(async () => {
      frameListeners[0]?.({ streamId: 'stream-1', bytes: new Uint8Array([1, 2, 3]).buffer })
    })

    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('blob:emulator-frame-1')
    expect(img?.className).toContain('object-contain')
    expect(img?.className).not.toContain('object-fill')
  })

  it('clears the previous frame while a new stream key is connecting', async () => {
    await renderStream('a')

    await act(async () => {
      frameListeners[0]?.({ streamId: 'stream-1', bytes: new Uint8Array([1, 2, 3]).buffer })
    })

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:emulator-frame-1')

    await renderStream('b')

    expect(container.querySelector('img')).toBeNull()
    expect(stopFrameStream).toHaveBeenCalledWith({ streamId: 'stream-1' })

    await act(async () => {
      frameListeners[0]?.({ streamId: 'stream-2', bytes: new Uint8Array([4, 5, 6]).buffer })
    })

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:emulator-frame-2')
  })

  it('uses advertised iOS video without starting a parallel JPEG stream', async () => {
    await renderStream('abc', IOS_VIDEO)
    expect(startVideoStream).toHaveBeenCalledWith({
      deviceId: IOS_VIDEO.deviceId,
      avccStreamUrl: IOS_VIDEO.avccStreamUrl,
      streamId: expect.any(String)
    })
    expect(container.querySelector('canvas')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(startFrameStream).not.toHaveBeenCalled()
  })

  it.each(['iOS AVCC', 'Android Annex-B'] as const)(
    'renders %s video with key-frame gating and zero-copy subsequent access units',
    async (platform) => {
      const avcc = platform === 'iOS AVCC'
      const deviceId = avcc ? IOS_VIDEO.deviceId : 'android-device'
      const config = avcc ? AVCC_CONFIG : new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0, 0, 0, 1, 0x68])
      const key = avcc ? new Uint8Array([0, 0, 0, 2, 0x65, 1]) : new Uint8Array([0, 0, 0, 1, 0x65])
      const delta = avcc
        ? new Uint8Array([0, 0, 0, 2, 0x41, 2])
        : new Uint8Array([0, 0, 0, 1, 0x41])
      await renderStream('video', avcc ? IOS_VIDEO : { previewUrl: 'scrcpy://android-device' })

      emitVideoFrame(key, { keyFrame: true }, deviceId)
      expect(decodeChunk).not.toHaveBeenCalled()
      emitVideoFrame(config, { config: true }, deviceId)
      expect(configureDecoder).toHaveBeenCalledExactlyOnceWith(
        avcc
          ? { codec: 'avc1.640028', description: AVCC_CONFIG, optimizeForLatency: true }
          : { codec: 'avc1.640028', optimizeForLatency: true }
      )
      emitVideoFrame(delta, {}, deviceId)
      expect(decodeChunk).not.toHaveBeenCalled()
      emitVideoFrame(key, { keyFrame: true }, deviceId)
      emitVideoFrame(delta, {}, deviceId)
      expect(decodeChunk.mock.calls.map(([chunk]) => [chunk.type, chunk.data])).toEqual([
        ['key', avcc ? key : new Uint8Array([...config, ...key])],
        ['delta', delta]
      ])
      if (avcc) {
        expect(decodeChunk.mock.calls[0][0].data.buffer).toBe(key.buffer)
      }
      expect(decodeChunk.mock.calls[1][0].data.buffer).toBe(delta.buffer)

      const frame = { displayWidth: 240, displayHeight: 480, close: vi.fn() }
      act(() => decoderOutput(frame))
      expect(container.querySelector('canvas')?.width).toBe(240)
      expect(container.querySelector('canvas')?.height).toBe(480)
      expect(drawImage).toHaveBeenCalledExactlyOnceWith(frame, 0, 0)
      expect(frame.close).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      expect(startFrameStream).not.toHaveBeenCalled()

      emitVideoFrame(config, { config: true }, deviceId)
      emitVideoFrame(delta, {}, deviceId)
      expect(resetDecoder).toHaveBeenCalledOnce()
      expect(decodeChunk).toHaveBeenCalledTimes(2)
      emitVideoFrame(key, { keyFrame: true }, deviceId)
      expect(decodeChunk).toHaveBeenCalledTimes(3)
    }
  )

  it('does not let a late JPEG seed replace decoded video and closes its bitmap', async () => {
    const bitmapResult = Promise.withResolvers<SeedBitmap>()
    const createBitmap = vi.fn(() => bitmapResult.promise)
    vi.stubGlobal('createImageBitmap', createBitmap)
    await renderStream('video', IOS_VIDEO)
    emitVideoFrame(new Uint8Array([1]), { seed: true })
    const frame = { displayWidth: 240, displayHeight: 480, close: vi.fn() }
    act(() => decoderOutput(frame))
    const bitmap = { width: 480, height: 240, close: vi.fn() }
    await act(async () => bitmapResult.resolve(bitmap))

    expect(drawImage).toHaveBeenCalledExactlyOnceWith(frame, 0, 0)
    expect(container.querySelector('canvas')?.width).toBe(240)
    expect(container.querySelector('canvas')?.height).toBe(480)
    expect(frame.close).toHaveBeenCalledOnce()
    expect(bitmap.close).toHaveBeenCalledOnce()
    emitVideoFrame(new Uint8Array([2]), { seed: true })
    expect(createBitmap).toHaveBeenCalledOnce()
  })

  it('displays an early JPEG seed without extending the first-video-frame deadline', async () => {
    const bitmap = { width: 240, height: 480, close: vi.fn() }
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap)
    )
    await renderStream('video', IOS_VIDEO)
    await act(async () => emitVideoFrame(new Uint8Array([1]), { seed: true }))

    expect(container.querySelector('canvas')?.width).toBe(240)
    expect(container.querySelector('canvas')?.height).toBe(480)
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(bitmap, 0, 0)
    expect(bitmap.close).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(10_000))
    expect(container.querySelector('canvas')).toBeNull()
    expect(startFrameStream).toHaveBeenCalledOnce()
    expect(stopVideoStream).toHaveBeenCalledWith({ streamId: videoStreamId })
    expect(closeDecoder).toHaveBeenCalledOnce()
  })

  it('releases pending start, seed and decoded-frame resources after unmount', async () => {
    const started = Promise.withResolvers<{ streamId: string }>()
    const bitmapResult = Promise.withResolvers<SeedBitmap>()
    startVideoStream.mockImplementationOnce((args: EmulatorVideoStreamStartArgs) => {
      videoStreamId = args.streamId
      return started.promise
    })
    vi.stubGlobal('createImageBitmap', () => bitmapResult.promise)
    await renderStream('video', IOS_VIDEO)
    emitVideoFrame(new Uint8Array([1]), { seed: true })
    const streamId = videoStreamId
    const output = decoderOutput
    await act(async () => root.render(null))

    expect(closeDecoder).toHaveBeenCalledOnce()
    expect(stopVideoStream).toHaveBeenCalledWith({ streamId })
    expect(videoFrameListeners).toHaveLength(0)
    expect(videoErrorListeners).toHaveLength(0)
    expect(errorListeners).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    stopVideoStream.mockClear()
    const bitmap = { width: 240, height: 480, close: vi.fn() }
    const frame = { displayWidth: 240, displayHeight: 480, close: vi.fn() }
    await act(async () => {
      bitmapResult.resolve(bitmap)
      started.resolve({ streamId })
      output(frame)
    })

    expect(stopVideoStream).toHaveBeenCalledExactlyOnceWith({ streamId })
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(frame.close).toHaveBeenCalledOnce()
    expect(drawImage).not.toHaveBeenCalled()
    expect(closeDecoder).toHaveBeenCalledOnce()
    expect(onStreamError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    'transport',
    'decoder',
    'start',
    'configure',
    'decode',
    'display',
    'unsupported'
  ] as const)(
    'switches once to JPEG after iOS %s failure and keeps fallback stable',
    async (failure) => {
      if (failure === 'start') {
        startVideoStream.mockImplementationOnce(async (args: EmulatorVideoStreamStartArgs) => {
          videoStreamId = args.streamId
          throw new Error('start failed')
        })
      } else if (failure === 'unsupported') {
        vi.stubGlobal('VideoDecoder', undefined)
      }
      await renderStream('abc', IOS_VIDEO)
      const lateError = videoErrorListeners[0]
      await act(async () => {
        if (failure === 'transport') {
          videoErrorListeners[0]?.({
            streamId: videoStreamId,
            deviceId: IOS_VIDEO.deviceId,
            message: 'transport failed'
          })
        } else if (failure === 'decoder') {
          decoderError(new DOMException('decoder failed'))
        } else if (failure === 'configure' || failure === 'decode') {
          const fail = (): never => {
            throw new Error('decoder failed')
          }
          if (failure === 'configure') {
            configureDecoder.mockImplementationOnce(fail)
          } else {
            decodeChunk.mockImplementationOnce(fail)
          }
          emitVideoFrame(AVCC_CONFIG, { config: true })
          if (failure === 'decode') {
            emitVideoFrame(new Uint8Array([0, 0, 0, 2, 0x65, 1]), { keyFrame: true })
          }
        } else if (failure === 'display') {
          drawImage.mockImplementationOnce(() => {
            throw new Error('display failed')
          })
          const frame = { displayWidth: 240, displayHeight: 480, close: vi.fn() }
          decoderOutput(frame)
          expect(frame.close).toHaveBeenCalledOnce()
        }
      })
      expect(startFrameStream).toHaveBeenCalledTimes(1)
      expect(container.querySelector('canvas')).toBeNull()
      expect(onStreamError).not.toHaveBeenCalled()
      if (failure !== 'unsupported') {
        expect(stopVideoStream).toHaveBeenCalledWith({ streamId: videoStreamId })
        expect(closeDecoder).toHaveBeenCalledOnce()
      }
      await act(async () => {
        frameListeners[0]?.({ streamId: 'stream-1', bytes: new Uint8Array([1, 2, 3]).buffer })
        lateError?.({
          streamId: videoStreamId,
          deviceId: IOS_VIDEO.deviceId,
          message: 'late transport error'
        })
      })
      await renderStream('abc', IOS_VIDEO)
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:emulator-frame-1')
      expect(startFrameStream).toHaveBeenCalledTimes(1)
      expect(startVideoStream).toHaveBeenCalledTimes(failure === 'unsupported' ? 0 : 1)
      expect(onStreamError).not.toHaveBeenCalled()
    }
  )

  it('enters the browser iOS JPEG fallback without waiting for the video timeout', async () => {
    const emulator = createEmulatorApi()
    const startJpeg = vi.spyOn(emulator, 'startFrameStream')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: withFallback({ emulator }, [])
    })

    await renderStream('browser-ios', IOS_VIDEO)

    expect(startJpeg).toHaveBeenCalledExactlyOnceWith({
      streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
      streamKey: 'browser-ios'
    })
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.textContent).toContain('Stream disconnected')
    expect(onStreamError).toHaveBeenCalledOnce()
    expect(closeDecoder).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    await act(async () => root.render(null))
    expect(closeDecoder).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['API', 'WebCodecs', 'decoder construction', 'decoder callback'] as const)(
    'keeps an Android %s failure until disabled and starts fresh on same-key re-enable',
    async (source) => {
      const api = window.api
      const readDecoder = vi.fn()
      if (source === 'API') {
        Object.defineProperty(window, 'api', { configurable: true, value: {} })
        Object.defineProperty(globalThis, 'VideoDecoder', {
          configurable: true,
          get: readDecoder
        })
      } else if (source === 'WebCodecs') {
        vi.stubGlobal('VideoDecoder', undefined)
      } else if (source === 'decoder construction') {
        vi.stubGlobal(
          'VideoDecoder',
          class {
            constructor() {
              throw new Error('decoder failed')
            }
          }
        )
      }
      const props = { previewUrl: 'scrcpy://android-device' }
      await renderStream('android', props)
      if (source === 'decoder callback') {
        act(() => decoderError(new DOMException('decoder failed')))
      }
      expect(container.querySelector('canvas')).toBeNull()
      expect(container.textContent).toContain('Stream disconnected')
      expect(onStreamError).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      if (source === 'API') {
        expect(readDecoder).not.toHaveBeenCalled()
      }
      const starts = startVideoStream.mock.calls.length

      await renderStream('android', props)
      expect(container.querySelector('canvas')).toBeNull()
      expect(container.textContent).toContain('Stream disconnected')
      expect(startVideoStream).toHaveBeenCalledTimes(starts)
      expect(onStreamError).toHaveBeenCalledOnce()

      await renderStream('android', { ...props, showStream: false })
      expect(container.textContent).toContain('Emulator preview')
      expect(vi.getTimerCount()).toBe(0)
      Object.defineProperty(window, 'api', { configurable: true, value: api })
      vi.stubGlobal('VideoDecoder', TestVideoDecoder)
      const firstReplacementRender: boolean[] = []
      startVideoStream.mockImplementationOnce(async (args: EmulatorVideoStreamStartArgs) => {
        videoStreamId = args.streamId
        firstReplacementRender.push(container.querySelector('canvas') !== null)
        return { streamId: args.streamId }
      })

      await renderStream('android', props)

      expect(firstReplacementRender).toEqual([true])
      expect(container.querySelector('canvas')).not.toBeNull()
      expect(container.textContent).not.toContain('Stream disconnected')
      expect(startVideoStream).toHaveBeenCalledTimes(starts + 1)
      expect(onStreamError).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(1)
      expect(startFrameStream).not.toHaveBeenCalled()
    }
  )

  it('retries video only after parking or changing sessions, not while JPEG fallback is active', async () => {
    await renderStream('abc', IOS_VIDEO)
    await act(async () => {
      videoErrorListeners[0]?.({
        streamId: videoStreamId,
        deviceId: IOS_VIDEO.deviceId,
        message: 'transport failed'
      })
    })
    expect(startFrameStream).toHaveBeenCalledTimes(1)
    const firstReplacementRender: boolean[] = []
    startVideoStream.mockImplementationOnce(async (args: EmulatorVideoStreamStartArgs) => {
      videoStreamId = args.streamId
      firstReplacementRender.push(container.querySelector('canvas') !== null)
      return { streamId: args.streamId }
    })
    await renderStream('next', IOS_VIDEO)
    expect(stopFrameStream).toHaveBeenCalledWith({ streamId: 'stream-1' })
    expect(startVideoStream).toHaveBeenCalledTimes(2)
    expect(startFrameStream).toHaveBeenCalledTimes(1)
    expect(container.querySelector('canvas')).not.toBeNull()
    expect(firstReplacementRender).toEqual([true])
    await renderStream('next', { ...IOS_VIDEO, showStream: false })
    expect(stopVideoStream).toHaveBeenCalledWith({ streamId: videoStreamId })
    await renderStream('next', IOS_VIDEO)
    expect(startVideoStream).toHaveBeenCalledTimes(3)
    expect(startFrameStream).toHaveBeenCalledTimes(1)
  })

  it.each(['transport', 'end'] as const)(
    'reports Android %s without starting JPEG and releases the failed session',
    async (source) => {
      await renderStream('android', { previewUrl: 'scrcpy://android-device' })
      expect(startVideoStream).toHaveBeenCalledWith({
        deviceId: 'android-device',
        streamId: expect.any(String)
      })
      expect(container.querySelector('canvas')).not.toBeNull()
      const streamId = videoStreamId
      const lateError = videoErrorListeners[0]
      const lateEnd = errorListeners[0]
      await act(async () => {
        if (source === 'transport') {
          videoErrorListeners[0]?.({
            streamId,
            deviceId: 'android-device',
            message: 'transport failed'
          })
        } else {
          errorListeners[0]?.({ streamId, message: 'The Android video stream ended.' })
        }
      })
      expect(container.querySelector('canvas')).toBeNull()
      expect(container.textContent).toContain('Stream disconnected')
      expect(onStreamError).toHaveBeenCalledOnce()
      expect(stopVideoStream).toHaveBeenCalledWith({ streamId })
      expect(closeDecoder).toHaveBeenCalledOnce()
      expect(videoFrameListeners).toHaveLength(0)
      expect(videoErrorListeners).toHaveLength(0)
      expect(errorListeners).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(startFrameStream).not.toHaveBeenCalled()

      await renderStream('replacement', { previewUrl: 'scrcpy://android-device' })
      await act(async () => {
        lateError?.({ streamId, deviceId: 'android-device', message: 'stale transport error' })
        lateEnd?.({ streamId, message: 'stale end' })
      })
      expect(container.querySelector('canvas')).not.toBeNull()
      expect(onStreamError).toHaveBeenCalledOnce()
      expect(startVideoStream).toHaveBeenCalledTimes(2)
    }
  )
})
