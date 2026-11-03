import { useEffect, useRef, useState } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { EmulatorVideoApi } from '../../../../shared/emulator-video-stream'

type VideoStreamFailure = {
  deviceId: string
  streamKey?: string
  avccStreamUrl?: string
  message: string
}

// Use Annex-B without avcC; prepend the SPS/PPS packet to the first keyframe.
const H264_CODEC = 'avc1.640028'

type StreamSize = { width: number; height: number }

function newVideoStreamId(): string {
  return createBrowserUuid()
}

export function useEmulatorVideoStream(
  deviceId: string | undefined,
  streamKey: string | undefined,
  enabled: boolean,
  onSize?: (size: StreamSize) => void,
  avccStreamUrl?: string
): { canvasRef: React.RefObject<HTMLCanvasElement | null>; error: string | null } {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [failure, setFailure] = useState<VideoStreamFailure | null>(null)
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize

  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- cleanup() clears the first-frame timeout.
  useEffect(() => {
    const api = window.api?.emulator satisfies EmulatorVideoApi | undefined
    setFailure(null)
    if (!enabled || !deviceId) {
      return
    }
    const reportError = (message: string): void => {
      setFailure({ deviceId, streamKey, avccStreamUrl, message })
    }
    const apiUnavailable = !api?.startVideoStream
    const DecoderCtor = apiUnavailable ? undefined : globalThis.VideoDecoder
    const ChunkCtor = apiUnavailable ? undefined : globalThis.EncodedVideoChunk
    if (apiUnavailable || !DecoderCtor || !ChunkCtor) {
      reportError(
        apiUnavailable
          ? 'Video streaming is unavailable.'
          : 'This build does not support WebCodecs H.264 decoding.'
      )
      return
    }

    let disposed = false
    let configured = false
    let waitingForKeyFrame = true
    let hasVideoFrame = false
    let timestamp = 0
    let configBytes: Uint8Array | null = null
    let reportedSize: StreamSize | null = null
    let decoder: VideoDecoder | null = null
    let firstFrameTimeout: ReturnType<typeof setTimeout> | null = null
    const reportSize = (width: number, height: number): void => {
      if (reportedSize?.width === width && reportedSize.height === height) {
        return
      }
      reportedSize = { width, height }
      onSizeRef.current?.(reportedSize)
    }
    const currentStreamId = newVideoStreamId()
    let streamId: string | null = currentStreamId
    let unsubMeta: (() => void) | undefined
    let unsubFrame: (() => void) | undefined
    let unsubError: (() => void) | undefined
    let unsubEnd: (() => void) | undefined
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas) {
      ctx?.clearRect(0, 0, canvas.width, canvas.height)
    }

    const clearFirstFrameTimeout = (): void => {
      if (firstFrameTimeout !== null) {
        clearTimeout(firstFrameTimeout)
        firstFrameTimeout = null
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
      unsubError?.()
      unsubEnd?.()
      unsubMeta = undefined
      unsubFrame = undefined
      unsubError = undefined
      unsubEnd = undefined
      if (streamId) {
        void api.stopVideoStream?.({ streamId })
        streamId = null
      }
      if (decoder && decoder.state !== 'closed') {
        decoder.close()
      }
    }

    function fatal(message: string): void {
      if (disposed) {
        return
      }
      reportError(message)
      cleanup()
    }

    async function drawSeed(bytes: ArrayBuffer): Promise<void> {
      if (hasVideoFrame || !canvas || !ctx || typeof globalThis.createImageBitmap !== 'function') {
        return
      }
      let bitmap: ImageBitmap | null = null
      try {
        bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
        if (disposed || hasVideoFrame) {
          return
        }
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        ctx.drawImage(bitmap, 0, 0)
        reportSize(bitmap.width, bitmap.height)
      } catch {
        // The optional seed must not change the video stream's health or first-frame deadline.
      } finally {
        bitmap?.close()
      }
    }

    try {
      decoder = new DecoderCtor({
        output: (frame) => {
          try {
            if (disposed || !ctx || !canvas) {
              return
            }
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth
              canvas.height = frame.displayHeight
            }
            ctx.drawImage(frame, 0, 0)
            hasVideoFrame = true
            clearFirstFrameTimeout()
            reportSize(frame.displayWidth, frame.displayHeight)
          } catch (err) {
            fatal(err instanceof Error ? err.message : 'Failed to display a video frame.')
          } finally {
            frame.close()
          }
        },
        error: (err) => fatal(err.message)
      })
    } catch (err) {
      fatal(err instanceof Error ? err.message : 'Failed to create the H.264 decoder.')
      return cleanup
    }

    firstFrameTimeout = setTimeout(() => {
      fatal('Video stream did not deliver a frame.')
    }, 10_000)

    unsubMeta = api.onVideoStreamMeta?.((msg) => {
      if (!disposed && msg.streamId === streamId && msg.deviceId === deviceId) {
        reportSize(msg.meta.width, msg.meta.height)
      }
    })

    unsubError = api.onVideoStreamError?.((msg) => {
      if (!disposed && msg.streamId === streamId && msg.deviceId === deviceId) {
        fatal(msg.message || 'Video stream disconnected.')
      }
    })
    unsubEnd = api.onFrameStreamError?.((msg) => {
      if (!disposed && msg.streamId === streamId) {
        fatal(msg.message)
      }
    })

    unsubFrame = api.onVideoStreamFrame?.((msg) => {
      if (disposed || msg.streamId !== streamId || msg.deviceId !== deviceId || !decoder) {
        return
      }
      if (msg.seed) {
        if (avccStreamUrl) {
          void drawSeed(msg.bytes)
        }
        return
      }
      const data = new Uint8Array(msg.bytes)
      if (msg.config) {
        try {
          if (configured) {
            decoder.reset()
          }
          if (avccStreamUrl) {
            const codec = `avc1.${data[1].toString(16).padStart(2, '0')}${data[2]
              .toString(16)
              .padStart(2, '0')}${data[3].toString(16).padStart(2, '0')}`
            decoder.configure({ codec, description: data, optimizeForLatency: true })
          } else {
            decoder.configure({ codec: H264_CODEC, optimizeForLatency: true })
          }
          configured = true
          waitingForKeyFrame = true
          // Android uses Annex-B; WebCodecs needs SPS/PPS with the first IDR.
          configBytes = avccStreamUrl ? null : data
        } catch (err) {
          fatal(err instanceof Error ? err.message : 'Failed to configure the H.264 decoder.')
        }
        return
      }
      if (!configured || decoder.state === 'closed' || (waitingForKeyFrame && !msg.keyFrame)) {
        return
      }
      let chunkData = data
      if (msg.keyFrame && configBytes) {
        chunkData = new Uint8Array(configBytes.length + data.length)
        chunkData.set(configBytes, 0)
        chunkData.set(data, configBytes.length)
        configBytes = null
      }
      try {
        timestamp += 1
        decoder.decode(
          new ChunkCtor({
            type: msg.keyFrame ? 'key' : 'delta',
            timestamp,
            data: chunkData
          })
        )
        waitingForKeyFrame = false
      } catch (err) {
        fatal(err instanceof Error ? err.message : 'Failed to decode a video frame.')
      }
    })

    try {
      void api
        .startVideoStream({
          deviceId,
          streamId: currentStreamId,
          ...(avccStreamUrl ? { avccStreamUrl } : {})
        })
        .then((started) => {
          if (disposed) {
            void api.stopVideoStream?.({ streamId: started.streamId })
          }
        })
        .catch((err: unknown) => {
          fatal(err instanceof Error ? err.message : 'Failed to start the video stream.')
        })
    } catch (err) {
      fatal(err instanceof Error ? err.message : 'Failed to start the video stream.')
    }

    return cleanup
  }, [deviceId, streamKey, enabled, avccStreamUrl])

  const error =
    enabled &&
    failure &&
    failure.deviceId === deviceId &&
    failure.streamKey === streamKey &&
    failure.avccStreamUrl === avccStreamUrl
      ? failure.message
      : null
  return { canvasRef, error }
}
