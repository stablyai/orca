import { useCallback, useEffect, useRef } from 'react'
import type { DesktopAppInput, DesktopAppWindow } from '../../../../shared/desktop-app-types'
import { errorMessage } from '../../../../shared/error-message'
import { normalizeWheelDelta } from '../emulator-pane/emulator-screen-gesture'
import { mapKeyEventToDesktopAppInput } from './desktop-app-key-mapping'
import { mapElementPointToWindowPoint, type Point } from './desktop-app-point-mapping'
import { isMacDesktopAppHost } from '@/lib/open-desktop-app-tab'

const CLICK_SLOP_PX = 6

type PointerStart = { x: number; y: number; button: number }

/** Turns pointer, wheel and key events on the live picture into input for the real window. */
export function useDesktopAppInput(
  target: DesktopAppWindow | null,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  onError: (message: string | null) => void
) {
  const pointerStart = useRef<PointerStart | null>(null)
  const pendingScroll = useRef<{ point: Point; deltaX: number; deltaY: number } | null>(null)
  const scrollFrame = useRef(0)

  useEffect(() => {
    const frame = scrollFrame
    const pending = pendingScroll
    return () => {
      // Why: a scroll queued for the next frame must not reach the window after the view is gone.
      cancelAnimationFrame(frame.current)
      frame.current = 0
      pending.current = null
    }
  }, [])

  const send = useCallback(
    (input: DesktopAppInput) => {
      const api = window.api?.desktopApp
      if (!api || !target) {
        return
      }
      api
        .sendInput({ windowId: target.windowId, pid: target.pid, input })
        .then(() => onError(null))
        .catch((err: unknown) => onError(errorMessage(err)))
    },
    [target, onError]
  )

  const toWindowPoint = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const video = videoRef.current
      if (!video || !target) {
        return null
      }
      const rect = video.getBoundingClientRect()
      return mapElementPointToWindowPoint(
        { x: clientX - rect.left, y: clientY - rect.top },
        { width: rect.width, height: rect.height },
        { width: video.videoWidth, height: video.videoHeight },
        { width: target.bounds.width, height: target.bounds.height }
      )
    },
    [target, videoRef]
  )

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.currentTarget.focus()
    pointerStart.current = { x: event.clientX, y: event.clientY, button: event.button }
  }, [])

  // Why: mouseup, unlike pointerup (detail 0), carries the click count for double and triple clicks.
  const onMouseUp = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const start = pointerStart.current
      pointerStart.current = null
      if (!start || start.button !== event.button || (event.button !== 0 && event.button !== 2)) {
        return
      }
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) {
        return
      }
      const point = toWindowPoint(event.clientX, event.clientY)
      if (point) {
        send({
          kind: 'click',
          ...point,
          button: event.button === 2 ? 'right' : 'left',
          clickCount: Math.min(3, Math.max(1, event.detail))
        })
      }
    },
    [send, toWindowPoint]
  )

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLElement>) => {
      const point = toWindowPoint(event.clientX, event.clientY)
      if (!point) {
        return
      }
      // Why: wheel deltas arrive in lines or pages on some mice; the window expects pixels.
      const rect = event.currentTarget.getBoundingClientRect()
      const pending = pendingScroll.current
      pendingScroll.current = {
        point,
        deltaX:
          (pending?.deltaX ?? 0) + normalizeWheelDelta(event.deltaX, event.deltaMode, rect.width),
        deltaY:
          (pending?.deltaY ?? 0) + normalizeWheelDelta(event.deltaY, event.deltaMode, rect.height)
      }
      // Why: trackpads fire a wheel event per frame; one IPC round trip per frame is plenty.
      if (!scrollFrame.current) {
        scrollFrame.current = requestAnimationFrame(() => {
          scrollFrame.current = 0
          const next = pendingScroll.current
          pendingScroll.current = null
          if (next) {
            send({ kind: 'scroll', ...next.point, deltaX: next.deltaX, deltaY: next.deltaY })
          }
        })
      }
    },
    [send, toWindowPoint]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const input = mapKeyEventToDesktopAppInput(event.nativeEvent, isMacDesktopAppHost())
      if (!input) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      send(input)
    },
    [send]
  )

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLElement>) => {
      const text = event.clipboardData.getData('text/plain')
      if (text) {
        event.preventDefault()
        send({ kind: 'text', text })
      }
    },
    [send]
  )

  return { onPointerDown, onMouseUp, onWheel, onKeyDown, onPaste }
}
