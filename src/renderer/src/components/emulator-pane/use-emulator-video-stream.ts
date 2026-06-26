import { useEffect, useRef, useState } from 'react'

// ============================================================================
// UNVERIFIED — needs Electron + a live scrcpy session to validate.
// Decodes the Android H.264 stream (scrcpy access units forwarded over the
// emulator:videoStream* IPC) with WebCodecs and paints it to a <canvas>. This
// is the Android sibling of use-emulator-frame-stream (MJPEG/<img>). It cannot
// be unit-tested in the node Vitest env (no WebCodecs/DOM); the byte framing it
// consumes IS tested in src/main/emulator/android/scrcpy-video-frame-parser.
//
// Wiring still required (see docs/android-emulation-streaming.md):
//   - preload: expose emulator.startVideoStream / onVideoStreamMeta /
//     onVideoStreamFrame / stopVideoStream.
//   - emulator-screen-stream-content.tsx: render this canvas when
//     session.streamCodec === 'h264'.
// ============================================================================

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

// Default H.264 codec string; scrcpy emits Annex-B, so the decoder is configured
// without an avcC description. The exact profile/level may need adjusting per device.
const H264_CODEC = 'avc1.640028'

export function useEmulatorVideoStream(
  deviceId: string | undefined,
  enabled: boolean
): { canvasRef: React.RefObject<HTMLCanvasElement | null>; error: string | null } {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)

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

    const unsubFrame = api.onVideoStreamFrame?.((msg) => {
      if (disposed || msg.deviceId !== deviceId) {
        return
      }
      const data = new Uint8Array(msg.bytes)
      if (msg.config && !configured) {
        decoder.configure({ codec: H264_CODEC, optimizeForLatency: true })
        configured = true
      }
      if (!configured) {
        return
      }
      decoder.decode(
        new ChunkCtor({
          type: msg.config || msg.keyFrame ? 'key' : 'delta',
          timestamp: (timestamp += 1),
          data
        })
      )
    })

    void api.startVideoStream({ deviceId }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to start the Android video stream.')
    })

    return () => {
      disposed = true
      unsubFrame?.()
      api.stopVideoStream?.({ deviceId })
      if (decoder.state !== 'closed') {
        decoder.close()
      }
    }
  }, [deviceId, enabled])

  return { canvasRef, error }
}
