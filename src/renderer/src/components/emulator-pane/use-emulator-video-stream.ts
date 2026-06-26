import { useEffect, useRef, useState } from 'react'

// Decodes the Android H.264 stream (scrcpy access units forwarded over the
// emulator:videoStream* IPC) with WebCodecs and paints it to a <canvas>. The
// Android sibling of use-emulator-frame-stream (MJPEG/<img>). Validated against
// a real emulator; the byte framing is unit-tested in scrcpy-video-frame-parser.

type VideoFrameMessage = {
  deviceId: string
  config: boolean
  keyFrame: boolean
  bytes: ArrayBuffer
}
type VideoMetaMessage = {
  deviceId: string
  meta: { codecId: string; width: number; height: number }
}

type EmulatorVideoApi = {
  startVideoStream?: (args: { deviceId: string }) => Promise<void>
  stopVideoStream?: (args: { deviceId: string }) => void
  onVideoStreamMeta?: (cb: (msg: VideoMetaMessage) => void) => () => void
  onVideoStreamFrame?: (cb: (msg: VideoFrameMessage) => void) => () => void
}

// scrcpy emits Annex-B H.264; the decoder is configured without an avcC
// description and the SPS/PPS config packet is prepended to the first keyframe.
const H264_CODEC = 'avc1.640028'

type StreamSize = { width: number; height: number }

export function useEmulatorVideoStream(
  deviceId: string | undefined,
  enabled: boolean,
  onSize?: (size: StreamSize) => void
): { canvasRef: React.RefObject<HTMLCanvasElement | null>; error: string | null } {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize

  useEffect(() => {
    const api = (window as { api?: { emulator?: EmulatorVideoApi } }).api?.emulator
    if (!enabled || !deviceId || !api?.startVideoStream) {
      return
    }
    const DecoderCtor = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder
    const ChunkCtor = (globalThis as { EncodedVideoChunk?: typeof EncodedVideoChunk })
      .EncodedVideoChunk
    if (!DecoderCtor || !ChunkCtor) {
      setError('This build does not support WebCodecs H.264 decoding.')
      return
    }

    let disposed = false
    let configured = false
    let timestamp = 0
    let configBytes: Uint8Array | null = null
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null

    const decoder = new DecoderCtor({
      output: (frame) => {
        if (!disposed && ctx && canvas) {
          canvas.width = frame.displayWidth
          canvas.height = frame.displayHeight
          ctx.drawImage(frame, 0, 0)
        }
        frame.close()
      },
      error: (err) => setError(err.message)
    })

    const unsubMeta = api.onVideoStreamMeta?.((msg) => {
      if (!disposed && msg.deviceId === deviceId) {
        onSizeRef.current?.({ width: msg.meta.width, height: msg.meta.height })
      }
    })

    const unsubFrame = api.onVideoStreamFrame?.((msg) => {
      if (disposed || msg.deviceId !== deviceId) {
        return
      }
      const data = new Uint8Array(msg.bytes)
      // The config packet carries SPS/PPS; configure once and stash it to prepend
      // to the next keyframe (Annex-B), since WebCodecs needs them with the IDR.
      if (msg.config) {
        if (!configured) {
          decoder.configure({ codec: H264_CODEC, optimizeForLatency: true })
          configured = true
        }
        configBytes = data
        return
      }
      if (!configured) {
        return
      }
      let chunkData = data
      if (msg.keyFrame && configBytes) {
        chunkData = new Uint8Array(configBytes.length + data.length)
        chunkData.set(configBytes, 0)
        chunkData.set(data, configBytes.length)
        configBytes = null
      }
      decoder.decode(
        new ChunkCtor({
          type: msg.keyFrame ? 'key' : 'delta',
          timestamp: (timestamp += 1),
          data: chunkData
        })
      )
    })

    void api.startVideoStream({ deviceId }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to start the Android video stream.')
    })

    return () => {
      disposed = true
      unsubMeta?.()
      unsubFrame?.()
      api.stopVideoStream?.({ deviceId })
      if (decoder.state !== 'closed') {
        decoder.close()
      }
    }
  }, [deviceId, enabled])

  return { canvasRef, error }
}
