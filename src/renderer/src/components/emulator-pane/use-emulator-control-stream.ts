import { useCallback, useEffect, useRef, useState } from 'react'
import {
  encodeServeSimKeyboardFrame,
  type ServeSimKeyboardFrame
} from '../../../../shared/emulator-keyboard-frame'
import {
  encodeServeSimTouchFrame,
  type ServeSimTouchFrame
} from '../../../../shared/emulator-touch-frame'

const RECONNECT_DELAY_MS = 750
const KEYBOARD_FRAME_DELAY_MS = 4

export type EmulatorControlStream = {
  cancelKeyboardFrames: () => void
  connected: boolean
  sendKeyboardFrames: (frames: ServeSimKeyboardFrame[]) => boolean
  sendTouch: (touch: ServeSimTouchFrame) => boolean
}

export function useEmulatorControlStream(
  wsUrl: string | undefined,
  enabled: boolean
): EmulatorControlStream {
  const wsRef = useRef<WebSocket | null>(null)
  const keyboardTimerIdsRef = useRef<Set<number>>(new Set())
  const pressedKeyboardUsagesRef = useRef<Set<number>>(new Set())
  const [connected, setConnected] = useState(false)

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
    [getOpenSocket]
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
        // Why: serve-sim spaces keyboard HID frames slightly; sending
        // down/up/shift frames in the same tick can be dropped by CoreSimulator.
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

  return { cancelKeyboardFrames, connected, sendKeyboardFrames, sendTouch }
}
