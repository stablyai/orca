import { useEffect, useRef, useState } from 'react'

// Decodes the Android H.264 stream (scrcpy access units forwarded over the
// emulator:videoStream* IPC) with WebCodecs and paints it to a <canvas>. The
// Android sibling of use-emulator-frame-stream (MJPEG/<img>). Validated against
// a real emulator; the byte framing is unit-tested in scrcpy-video-frame-parser.

type VideoFrameMessage = {
  streamId: string
  deviceId: string
  config: boolean
  keyFrame: boolean
  bytes: ArrayBuffer
}
type VideoMetaMessage = {
  streamId: string
  deviceId: string
  meta: { codecId: string; width: number; height: number }
}

type EmulatorVideoApi = {
  startVideoStream?: (args: { deviceId: string; streamId: string }) => Promise<{ streamId: string }>
  stopVideoStream?: (args: { streamId: string }) => Promise<void>
  onVideoStreamMeta?: (cb: (msg: VideoMetaMessage) => void) => () => void
  onVideoStreamFrame?: (cb: (msg: VideoFrameMessage) => void) => () => void
}

// scrcpy emits Annex-B H.264; the decoder is configured without an avcC
// description and the SPS/PPS config packet is prepended to the first keyframe.
const H264_CODEC = 'avc1.640028'

type StreamSize = { width: number; height: number }

function newVideoStreamId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

function scheduleFirstFrameTimeout(onTimeout: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(onTimeout, 10_000)
}

export function useEmulatorVideoStream(
  deviceId: string | undefined,
  streamKey: string | undefined,
  enabled: boolean,
  onSize?: (size: StreamSize) => void,
  onScreenshotCanvasChange?: (canvas: HTMLCanvasElement | null) => void
): {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  error: string | null
} {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  const onSizeRef = useRef(onSize)
  const onScreenshotCanvasChangeRef = useRef(onScreenshotCanvasChange)
  onSizeRef.current = onSize
  onScreenshotCanvasChangeRef.current = onScreenshotCanvasChange

  useEffect(() => {
    const api = (window as { api?: { emulator?: EmulatorVideoApi } }).api?.emulator
    if (!enabled || !deviceId) {
      setError(null)
      onScreenshotCanvasChangeRef.current?.(null)
      return
    }
    if (!api?.startVideoStream) {
      onScreenshotCanvasChangeRef.current?.(null)
      return
    }
    setError(null)
    onScreenshotCanvasChangeRef.current?.(null)
    const DecoderCtor = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder
    const ChunkCtor = (globalThis as { EncodedVideoChunk?: typeof EncodedVideoChunk })
      .EncodedVideoChunk
    if (!DecoderCtor || !ChunkCtor) {
      setError('This build does not support WebCodecs H.264 decoding.')
      return
    }

    let disposed = false
    let configured = false
    let screenshotCanvasPublished = false
    let timestamp = 0
    let configBytes: Uint8Array | null = null
    const currentStreamId = newVideoStreamId()
    let streamId: string | null = currentStreamId
    let unsubMeta: (() => void) | undefined
    let unsubFrame: (() => void) | undefined
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas) {
      const context = canvas.getContext('2d')
      context?.clearRect(0, 0, canvas.width, canvas.height)
    }

    let firstFrameTimeout: ReturnType<typeof setTimeout> | null = null

    const clearFirstFrameTimeout = (): void => {
      if (firstFrameTimeout) {
        clearTimeout(firstFrameTimeout)
        firstFrameTimeout = null
      }
    }

    const decoder = new DecoderCtor({
      output: (frame) => {
        if (!disposed && ctx && canvas) {
          clearFirstFrameTimeout()
          // Resizing the canvas reallocates its backing store and forces a
          // reflow, so only do it when the frame dimensions actually change.
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth
            canvas.height = frame.displayHeight
          }
          try {
            ctx.drawImage(frame, 0, 0)
            if (!screenshotCanvasPublished) {
              screenshotCanvasPublished = true
              onScreenshotCanvasChangeRef.current?.(canvas)
            }
          } catch (error) {
            fatal(error instanceof Error ? error.message : 'Failed to draw an Android video frame.')
          }
        }
        frame.close()
      },
      error: (err) => fatal(err.message)
    })

    const stopStream = (): void => {
      if (streamId) {
        void api.stopVideoStream?.({ streamId })
        streamId = null
      }
    }

    const cleanup = (): void => {
      if (disposed) {
        return
      }
      disposed = true
      clearFirstFrameTimeout()
      unsubMeta?.()
      unsubFrame?.()
      unsubMeta = undefined
      unsubFrame = undefined
      stopStream()
      onScreenshotCanvasChangeRef.current?.(null)
      if (decoder.state !== 'closed') {
        decoder.close()
      }
    }

    function fatal(message: string): void {
      if (disposed) {
        return
      }
      setError(message)
      cleanup()
    }
    firstFrameTimeout = scheduleFirstFrameTimeout(() => {
      fatal('Android video stream did not deliver a frame.')
    })

    unsubMeta = api.onVideoStreamMeta?.((msg) => {
      if (!disposed && msg.streamId === streamId && msg.deviceId === deviceId) {
        onSizeRef.current?.({ width: msg.meta.width, height: msg.meta.height })
      }
    })

    unsubFrame = api.onVideoStreamFrame?.((msg) => {
      if (disposed || msg.streamId !== streamId || msg.deviceId !== deviceId) {
        return
      }
      const data = new Uint8Array(msg.bytes)
      // The config packet carries SPS/PPS; configure once and stash it to prepend
      // to the next keyframe (Annex-B), since WebCodecs needs them with the IDR.
      if (msg.config) {
        if (!configured) {
          // configure() can throw synchronously (TypeError on a bad config); the
          // decoder's async error callback won't catch it, so surface via fatal().
          try {
            decoder.configure({ codec: H264_CODEC, optimizeForLatency: true })
          } catch (err) {
            fatal(err instanceof Error ? err.message : 'Failed to configure the H.264 decoder.')
            return
          }
          configured = true
        }
        configBytes = data
        return
      }
      if (!configured || decoder.state === 'closed') {
        return
      }
      let chunkData = data
      if (msg.keyFrame && configBytes) {
        chunkData = new Uint8Array(configBytes.length + data.length)
        chunkData.set(configBytes, 0)
        chunkData.set(data, configBytes.length)
        configBytes = null
      }
      // decode() can throw synchronously (DataError/InvalidStateError on malformed
      // wire bytes); the async error callback won't catch it, so surface via fatal().
      try {
        timestamp += 1
        decoder.decode(
          new ChunkCtor({
            type: msg.keyFrame ? 'key' : 'delta',
            timestamp,
            data: chunkData
          })
        )
      } catch (err) {
        fatal(err instanceof Error ? err.message : 'Failed to decode an Android video frame.')
      }
    })

    void api
      .startVideoStream({ deviceId, streamId: currentStreamId })
      .then((started) => {
        if (disposed) {
          void api.stopVideoStream?.({ streamId: started.streamId })
        }
      })
      .catch((err: unknown) => {
        fatal(err instanceof Error ? err.message : 'Failed to start the Android video stream.')
      })

    return () => {
      cleanup()
    }
  }, [deviceId, streamKey, enabled])

  return { canvasRef, error }
}
