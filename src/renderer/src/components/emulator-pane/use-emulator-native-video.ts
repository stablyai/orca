import { useEffect, useRef, useState } from 'react'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import type { NativeVideoFrame } from '../../../../shared/emulator-native-video'
import { createRgbCanvas } from './emulator-rgb-canvas'

export function nativeEmulatorDeviceId(url: string | undefined): string | null {
  return url?.startsWith('android-grpc://') ? url.slice('android-grpc://'.length) || null : null
}

export function useEmulatorNativeVideo(
  deviceId: string | null,
  streamKey: string | undefined,
  enabled: boolean,
  onSize: (size: { width: number; height: number }) => void
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onSizeRef = useRef(onSize)
  useEffect(() => {
    onSizeRef.current = onSize
  }, [onSize])
  const identity = `${deviceId}:${streamKey}:${enabled}`
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !deviceId || !enabled) {
      return
    }
    const api = window.api.emulator
    let renderer: ReturnType<typeof createRgbCanvas>
    try {
      renderer = createRgbCanvas(canvas)
    } catch (error) {
      setFailure({ identity, message: String(error) })
      return
    }
    let disposed = false,
      streamId: string | null = null,
      sizeKey = ''
    let port: MessagePort | null = null
    let pending: NativeVideoFrame | null = null
    let raf = 0,
      resizeTimer = 0,
      lastSize = ''
    const metrics = { frames: 0, frameAgeMs: 0, maxFrameAgeMs: 0, sequence: 0, droppedFrames: 0 }
    Object.assign(canvas, { nativeVideoMetrics: metrics })
    const fail = (message: string) => {
      if (!disposed) {
        setFailure({ identity, message })
      }
    }
    const stop = () => {
      port?.close()
      port = null
      const previous = streamId
      streamId = null
      sizeKey = ''
      pending = null
      if (previous) {
        void api.stopNativeVideoStream(previous).catch(() => {})
      }
    }
    const subscribe = () => {
      if (disposed) {
        return
      }
      if (!getWindowParkVisible()) {
        stop()
        return
      }
      const rect = canvas.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      const width = Math.max(1, Math.min(4096, Math.ceil(rect.width * scale)))
      const height = Math.max(1, Math.min(4096, Math.ceil(rect.height * scale)))
      if (!rect.width || !rect.height) {
        stop()
        return
      }
      const key = `${width}:${height}`
      if (key === sizeKey) {
        return
      }
      stop()
      sizeKey = key
      const id = createBrowserUuid()
      streamId = id
      void api.startNativeVideoStream({ deviceId, streamId: id, width, height }).catch((error) => {
        if (streamId === id) {
          fail(String(error))
        }
      })
    }
    const receive = (frame: NativeVideoFrame) => {
      if (disposed || !streamId) {
        return
      }
      pending = frame
      // Release transport credit on receipt; waiting for paint serializes IPC behind vsync.
      port?.postMessage({ type: 'ack' })
      if (raf) {
        return
      }
      raf = requestAnimationFrame(() => {
        raf = 0
        const frame = pending
        pending = null
        if (!frame || !streamId) {
          return
        }
        try {
          renderer.draw(frame.pixels, frame.width, frame.height)
          const key = `${frame.width}:${frame.height}`
          if (key !== lastSize) {
            lastSize = key
            onSizeRef.current({ width: frame.width, height: frame.height })
          }
          metrics.frames++
          metrics.droppedFrames = frame.droppedFrames ?? 0
          metrics.sequence = frame.sequence
          metrics.frameAgeMs = Date.now() - Number(frame.timestampUs) / 1000
          metrics.maxFrameAgeMs = Math.max(metrics.maxFrameAgeMs, metrics.frameAgeMs)
          port?.postMessage({ type: 'presented', rotation: frame.rotation })
        } catch (error) {
          stop()
          fail(String(error))
        }
      })
    }
    const onPort = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== 'orca-native-video-port') {
        return
      }
      const incoming = event.ports[0]
      if (!incoming) {
        return
      }
      if (event.data.streamId !== streamId) {
        incoming.close()
        return
      }
      port?.close()
      port = incoming
      incoming.onmessage = (message: MessageEvent<NativeVideoFrame>) => {
        if (port === incoming && event.data.streamId === streamId) {
          receive(message.data)
        }
      }
      incoming.start()
    }
    window.addEventListener('message', onPort)
    const offError = api.onFrameStreamError((event) => {
      if (event.streamId === streamId) {
        stop()
        fail(event.message)
      }
    })
    const resize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(subscribe, 100)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    const offVisibility = subscribeWindowParkVisibility(subscribe)
    window.addEventListener('resize', resize)
    subscribe()
    return () => {
      disposed = true
      stop()
      window.removeEventListener('message', onPort)
      offError()
      observer.disconnect()
      cancelAnimationFrame(raf)
      window.clearTimeout(resizeTimer)
      offVisibility()
      window.removeEventListener('resize', resize)
      renderer.dispose()
    }
  }, [deviceId, enabled, identity, streamKey])
  return { canvasRef, error: failure?.identity === identity ? failure.message : null }
}
