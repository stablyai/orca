import { useCallback, useEffect, useRef, useState } from 'react'
import {
  encodeServeSimTouchFrame,
  type ServeSimTouchFrame
} from '../../../../shared/emulator-touch-frame'

const RECONNECT_DELAY_MS = 750

export type EmulatorTouchStream = {
  connected: boolean
  sendTouch: (touch: ServeSimTouchFrame) => boolean
}

export function useEmulatorTouchStream(
  wsUrl: string | undefined,
  enabled: boolean
): EmulatorTouchStream {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)

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
      const ws = wsRef.current
      if (ws) {
        wsRef.current = null
        ws.close()
      }
      setConnected(false)
    }
  }, [enabled, wsUrl])

  const getOpenSocket = useCallback((): WebSocket | null => {
    const ws = wsRef.current
    return ws?.readyState === WebSocket.OPEN ? ws : null
  }, [])

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

  return { connected, sendTouch }
}
