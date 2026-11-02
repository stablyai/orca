import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  encodeServeSimKeyboardFrame,
  type ServeSimKeyboardFrame
} from '../../../../shared/emulator-keyboard-frame'
import {
  encodeServeSimTouchFrame,
  type ServeSimTouchFrame
} from '../../../../shared/emulator-touch-frame'
import { RotateOrientation } from '../../../../shared/rpc-contract/emulator-params'
import type { EmulatorStreamOrientation } from './emulator-device-frame-layout'

const RECONNECT_DELAY_MS = 750
const KEYBOARD_FRAME_DELAY_MS = 4
const SERVE_SIM_CONFIG_MESSAGE_TAG = 130

// serve-sim pushes {width, height, orientation} on connect and on every rotate, fold or resize.
function decodeServeSimOrientation(data: unknown): EmulatorStreamOrientation | undefined {
  if (!(data instanceof ArrayBuffer)) {
    return undefined
  }
  const bytes = new Uint8Array(data)
  if (bytes[0] !== SERVE_SIM_CONFIG_MESSAGE_TAG) {
    return undefined
  }
  try {
    const config: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(1)))
    const orientation =
      typeof config === 'object' && config !== null && 'orientation' in config
        ? RotateOrientation.safeParse(config.orientation)
        : undefined
    return orientation?.success ? orientation.data : undefined
  } catch {
    return undefined
  }
}

export type ScrcpyKeyboard = {
  sendKey: (name: string, shift: boolean) => void
  sendText: (text: string) => Promise<boolean>
}

export type EmulatorControlStream = {
  cancelKeyboardFrames: () => void
  connected: boolean
  /** Android keys and text for main's scrcpy control socket; null for serve-sim sessions. */
  scrcpyKeyboard: ScrcpyKeyboard | null
  reportedOrientation: EmulatorStreamOrientation | null
  sendKeyboardFrames: (frames: ServeSimKeyboardFrame[]) => boolean
  sendTouch: (touch: ServeSimTouchFrame) => boolean
}

// Android has no serve-sim socket: its touches go to main, which owns the scrcpy control socket.
export function useEmulatorControlStream(
  wsUrl: string | undefined,
  enabled: boolean,
  scrcpyDeviceId: string | null = null
): EmulatorControlStream {
  const wsRef = useRef<WebSocket | null>(null)
  const keyboardTimerIdsRef = useRef<Set<number>>(new Set())
  const pressedKeyboardUsagesRef = useRef<Set<number>>(new Set())
  const [connected, setConnected] = useState(false)
  // Keyed by socket URL so a paused socket keeps the last orientation instead of dropping the picture's turn.
  const [reportedConfig, setReportedConfig] = useState<{
    wsUrl: string
    orientation: EmulatorStreamOrientation
  } | null>(null)

  const clearKeyboardTimers = useCallback((): void => {
    for (const timerId of keyboardTimerIdsRef.current) {
      window.clearTimeout(timerId)
    }
    keyboardTimerIdsRef.current.clear()
  }, [])

  const getOpenSocket = useCallback((): WebSocket | null => {
    const ws = wsRef.current
    return ws?.readyState === WebSocket.OPEN ? ws : null
  }, [])

  const sendKeyboardFrameNow = useCallback(
    (frame: ServeSimKeyboardFrame): boolean => {
      const ws = getOpenSocket()
      if (!ws) {
        return false
      }
      try {
        ws.send(encodeServeSimKeyboardFrame(frame))
        if (frame.type === 'down') {
          pressedKeyboardUsagesRef.current.add(frame.usage)
        } else {
          pressedKeyboardUsagesRef.current.delete(frame.usage)
        }
        return true
      } catch {
        return false
      }
    },
    [getOpenSocket]
  )

  const releasePressedKeyboardUsages = useCallback(
    (resetAfterRelease = false): void => {
      const usages = Array.from(pressedKeyboardUsagesRef.current).toReversed()
      for (const usage of usages) {
        sendKeyboardFrameNow({ type: 'up', usage })
      }
      if (resetAfterRelease) {
        pressedKeyboardUsagesRef.current.clear()
      }
    },
    [sendKeyboardFrameNow]
  )

  const cancelKeyboardFrames = useCallback((): void => {
    clearKeyboardTimers()
    releasePressedKeyboardUsages(true)
  }, [clearKeyboardTimers, releasePressedKeyboardUsages])

  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- cleanup closes the socket held in wsRef and stops reconnects.
  useEffect(() => {
    if (!enabled || !wsUrl) {
      setConnected(false)
      return
    }

    let disposed = false
    let reconnectTimerId: number | null = null

    const clearReconnectTimer = (): void => {
      if (reconnectTimerId !== null) {
        window.clearTimeout(reconnectTimerId)
        reconnectTimerId = null
      }
    }

    const connect = (): void => {
      clearReconnectTimer()
      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        if (!disposed && wsRef.current === ws) {
          releasePressedKeyboardUsages()
          setConnected(true)
        }
      }

      ws.onmessage = (event) => {
        const orientation = decodeServeSimOrientation(event.data)
        if (orientation && !disposed && wsRef.current === ws) {
          setReportedConfig({ wsUrl, orientation })
        }
      }

      ws.onerror = () => {
        setConnected(false)
        ws.close()
      }

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null
        }
        clearKeyboardTimers()
        setConnected(false)
        if (!disposed) {
          reconnectTimerId = window.setTimeout(connect, RECONNECT_DELAY_MS)
        }
      }
    }

    connect()

    return () => {
      disposed = true
      clearReconnectTimer()
      // Why: delayed HID frames may leave a modifier/key down if the tab closes
      // before the matching up frame runs. Release held usages while the socket
      // is still open, then cancel the remaining delayed queue.
      cancelKeyboardFrames()
      const ws = wsRef.current
      if (ws) {
        wsRef.current = null
        ws.close()
      }
      setConnected(false)
    }
  }, [cancelKeyboardFrames, clearKeyboardTimers, enabled, releasePressedKeyboardUsages, wsUrl])

  const sendTouch = useCallback(
    (touch: ServeSimTouchFrame): boolean => {
      // The frame only begins touches while it can interact; later phases must still release.
      if (scrcpyDeviceId) {
        window.api.emulator.sendScrcpyTouch({
          deviceId: scrcpyDeviceId,
          type: touch.type,
          x: touch.x,
          y: touch.y
        })
        return true
      }
      const ws = getOpenSocket()
      if (!ws) {
        return false
      }
      try {
        ws.send(encodeServeSimTouchFrame(touch))
        return true
      } catch {
        return false
      }
    },
    [getOpenSocket, scrcpyDeviceId]
  )

  const sendKeyboardFrames = useCallback(
    (frames: ServeSimKeyboardFrame[]): boolean => {
      if (frames.length === 0 || !getOpenSocket()) {
        return false
      }

      for (const [index, frame] of frames.entries()) {
        if (index === 0) {
          if (!sendKeyboardFrameNow(frame)) {
            return false
          }
          continue
        }
        // Space HID frames because CoreSimulator can drop down/up/shift events sent in the same tick.
        const timerId = window.setTimeout(() => {
          keyboardTimerIdsRef.current.delete(timerId)
          sendKeyboardFrameNow(frame)
        }, index * KEYBOARD_FRAME_DELAY_MS)
        keyboardTimerIdsRef.current.add(timerId)
      }
      return true
    },
    [getOpenSocket, sendKeyboardFrameNow]
  )

  const scrcpyKeyboard = useMemo<ScrcpyKeyboard | null>(
    () =>
      scrcpyDeviceId
        ? {
            sendKey: (key, shift) =>
              void window.api.emulator
                .sendScrcpyKeyboard({ deviceId: scrcpyDeviceId, key, shift })
                .catch(() => false),
            sendText: (text) =>
              window.api.emulator
                .sendScrcpyKeyboard({ deviceId: scrcpyDeviceId, text })
                .catch(() => false)
          }
        : null,
    [scrcpyDeviceId]
  )

  const reportedOrientation =
    reportedConfig && reportedConfig.wsUrl === wsUrl ? reportedConfig.orientation : null
  return {
    cancelKeyboardFrames,
    connected,
    reportedOrientation,
    scrcpyKeyboard,
    sendKeyboardFrames,
    sendTouch
  }
}
