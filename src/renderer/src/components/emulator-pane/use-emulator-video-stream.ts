import { useEffect, useRef, useState } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'

// Decode Android scrcpy H.264 access units from IPC onto a canvas; iOS uses the MJPEG hook.

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
  onFrameStreamError?: (cb: (msg: { streamId: string; message: string }) => void) => () => void
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
  onSize?: (size: StreamSize) => void
): { canvasRef: React.RefObject<HTMLCanvasElement | null>; error: string | null } {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Key errors to their stream so a dead stream's error never reaches its replacement's first render.
  const streamIdentity = `${deviceId}:${streamKey}:${enabled}`
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null)
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize

  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- cleanup() clears the first-frame timeout.
  useEffect(() => {
    const api = (window as { api?: { emulator?: EmulatorVideoApi } }).api?.emulator
    const identity = `${deviceId}:${streamKey}:${enabled}`
    const setError = (message: string): void => setFailure({ identity, message })
    if (!enabled || !deviceId || !api?.startVideoStream) {
      return
    }
    const DecoderCtor = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder
    const ChunkCtor = (globalThis as { EncodedVideoChunk?: typeof EncodedVideoChunk })
      .EncodedVideoChunk
    if (!DecoderCtor || !ChunkCtor) {
      return
    }

    let disposed = false
    let configured = false
    let timestamp = 0
    let configBytes: Uint8Array | null = null
    let reportedSize: StreamSize | null = null
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
    let unsubEnd: (() => void) | undefined
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas) {
      const context = canvas.getContext('2d')
      context?.clearRect(0, 0, canvas.width, canvas.height)
    }

    const decoder = new DecoderCtor({
      output: (frame) => {
        if (!disposed && ctx && canvas) {
          clearFirstFrameTimeout()
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth
            canvas.height = frame.displayHeight
          }
          reportSize(frame.displayWidth, frame.displayHeight)
          ctx.drawImage(frame, 0, 0)
        }
        frame.close()
      },
      error: (err) => fatal(err.message)
    })

    let firstFrameTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      fatal('Android video stream did not deliver a frame.')
    }, 10_000)

    const clearFirstFrameTimeout = (): void => {
      if (firstFrameTimeout) {
        clearTimeout(firstFrameTimeout)
        firstFrameTimeout = null
      }
    }

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
      unsubEnd?.()
      unsubMeta = undefined
      unsubFrame = undefined
      unsubEnd = undefined
      stopStream()
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

    unsubMeta = api.onVideoStreamMeta?.((msg) => {
      if (!disposed && msg.streamId === streamId && msg.deviceId === deviceId) {
        reportSize(msg.meta.width, msg.meta.height)
      }
    })

    unsubEnd = api.onFrameStreamError?.((msg) => {
      if (msg.streamId === streamId) {
        fatal(msg.message)
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
      if (!configured) {
        return
      }
      if (decoder.state === 'closed') {
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

  if (enabled && deviceId && !hasWebCodecs()) {
    return {
      canvasRef,
      error: 'This build does not support WebCodecs H.264 decoding.'
    }
  }
  return { canvasRef, error: failure?.identity === streamIdentity ? failure.message : null }
}

function hasWebCodecs(): boolean {
  return 'VideoDecoder' in globalThis && 'EncodedVideoChunk' in globalThis
}
