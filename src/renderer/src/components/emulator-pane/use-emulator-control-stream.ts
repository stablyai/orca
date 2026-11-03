import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type {
  EmulatorControlApi,
  EmulatorControlStreamStatus
} from '../../../../shared/emulator-control-stream'
import {
  encodeServeSimKeyboardFrame,
  type ServeSimKeyboardFrame
} from '../../../../shared/emulator-keyboard-frame'
import {
  encodeServeSimTouchFrame,
  type ServeSimTouchFrame
} from '../../../../shared/emulator-touch-frame'
import type { EmulatorStreamOrientation } from './emulator-device-frame-layout'

const RECONNECT_DELAY_MS = 750
const KEYBOARD_FRAME_DELAY_MS = 4

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
  const streamRef = useRef<EmulatorControlStreamStatus | null>(null)
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

  const getConnectedStreamId = useCallback((): string | null => {
    const stream = streamRef.current
    return stream?.connected ? stream.streamId : null
  }, [])

  const sendKeyboardFrameNow = useCallback(
    (frame: ServeSimKeyboardFrame): boolean => {
      const streamId = getConnectedStreamId()
      if (!streamId) {
        return false
      }
      try {
        window.api.emulator.sendControlFrame({
          streamId,
          bytes: encodeServeSimKeyboardFrame(frame)
        })
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
    [getConnectedStreamId]
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

    const api: EmulatorControlApi = window.api.emulator
    let disposed = false
    let reconnectTimerId: number | null = null

    const clearReconnectTimer = (): void => {
      if (reconnectTimerId !== null) {
        window.clearTimeout(reconnectTimerId)
        reconnectTimerId = null
      }
    }

    const disconnect = (streamId: string): void => {
      if (disposed || streamRef.current?.streamId !== streamId) {
        return
      }
      streamRef.current = null
      clearKeyboardTimers()
      setConnected(false)
      api.stopControlStream({ streamId })
      clearReconnectTimer()
      reconnectTimerId = window.setTimeout(connect, RECONNECT_DELAY_MS)
    }

    const connect = (): void => {
      clearReconnectTimer()
      const streamId = createBrowserUuid()
      streamRef.current = { streamId, connected: false }
      setConnected(false)
      try {
        void api
          .startControlStream({
            streamId,
            wsUrl,
            pressedKeyboardUsages: [...pressedKeyboardUsagesRef.current]
          })
          .catch(() => {
            disconnect(streamId)
          })
      } catch {
        disconnect(streamId)
      }
    }

    const unsubscribe = api.onControlStreamStatus((status) => {
      const stream = streamRef.current
      if (disposed || stream?.streamId !== status.streamId) {
        return
      }
      if (status.connected) {
        if (!stream.connected) {
          stream.connected = true
          releasePressedKeyboardUsages()
        }
        if (status.orientation) {
          setReportedConfig({ wsUrl, orientation: status.orientation })
        }
        setConnected(true)
      } else {
        for (const usage of status.pressedKeyboardUsages ?? []) {
          pressedKeyboardUsagesRef.current.add(usage)
        }
        disconnect(status.streamId)
      }
    })

    connect()

    return () => {
      disposed = true
      unsubscribe()
      clearReconnectTimer()
      // Why: delayed HID frames may leave a modifier/key down if the tab closes
      // before the matching up frame runs. Release held usages while the control
      // stream is still open, then cancel the remaining delayed queue.
      cancelKeyboardFrames()
      const stream = streamRef.current
      if (stream) {
        streamRef.current = null
        api.stopControlStream({ streamId: stream.streamId })
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
      const streamId = getConnectedStreamId()
      if (!streamId) {
        return false
      }
      try {
        window.api.emulator.sendControlFrame({ streamId, bytes: encodeServeSimTouchFrame(touch) })
        return true
      } catch {
        return false
      }
    },
    [getConnectedStreamId, scrcpyDeviceId]
  )

  const sendKeyboardFrames = useCallback(
    (frames: ServeSimKeyboardFrame[]): boolean => {
      if (frames.length === 0 || !getConnectedStreamId()) {
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
    [getConnectedStreamId, sendKeyboardFrameNow]
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
