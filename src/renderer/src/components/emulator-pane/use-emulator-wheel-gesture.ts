import { useCallback, useEffect, useRef } from 'react'
import {
  buildWheelGesturePoints,
  resolveWheelGestureStep,
  type EmulatorGesturePoint,
  type EmulatorScreenPoint
} from './emulator-screen-gesture'

type WheelGesture = {
  start: EmulatorScreenPoint
  end: EmulatorScreenPoint
  remaining: EmulatorScreenPoint
  live: boolean
  moveTimer: number | null
  endTimer: number | null
  tailFrames: number
  firstMove: boolean
}

type WheelInput = { start: EmulatorScreenPoint; delta: EmulatorScreenPoint }

export function useEmulatorWheelGesture(
  sendTouch: (point: EmulatorGesturePoint) => boolean,
  onGesture: (points: EmulatorGesturePoint[]) => void
): {
  cancel: () => void
  queue: (input: WheelInput) => void
} {
  const gestureRef = useRef<WheelGesture | null>(null)
  const endSegment = useCallback(
    (gesture: WheelGesture) => {
      if (gesture.live) {
        sendTouch({ ...gesture.end, type: 'end' })
      } else {
        const points = buildWheelGesturePoints(gesture.start, gesture.end, 1e-9)
        if (points) {
          onGesture(points)
        }
      }
    },
    [onGesture, sendTouch]
  )

  const finish = useCallback(() => {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (!gesture) {
      return
    }
    if (gesture.moveTimer !== null) {
      window.clearTimeout(gesture.moveTimer)
    }
    if (gesture.endTimer !== null) {
      window.clearTimeout(gesture.endTimer)
    }
    endSegment(gesture)
  }, [endSegment])

  const advance = useCallback(
    function advanceWheelGesture() {
      const gesture = gestureRef.current
      if (!gesture) {
        return
      }
      const distance = Math.hypot(gesture.remaining.x, gesture.remaining.y)
      // An even, slow release: a final jump can be the last motion UIKit sees and trigger a fling.
      if (gesture.tailFrames === 0 && !gesture.firstMove && distance <= 0.01) {
        gesture.tailFrames = 6
      }
      let fraction = 0.35
      if (gesture.tailFrames > 0) {
        fraction = 1 / gesture.tailFrames
      } else if (gesture.firstMove) {
        fraction = Math.min(0.9, 0.012 / distance)
      }
      const segment = resolveWheelGestureStep(gesture.end, {
        x: gesture.remaining.x * fraction,
        y: gesture.remaining.y * fraction
      })
      if (!segment) {
        gesture.moveTimer = null
        gesture.endTimer = window.setTimeout(finish, 80)
        return
      }
      if (segment.start.x !== gesture.end.x || segment.start.y !== gesture.end.y) {
        endSegment(gesture)
        gesture.start = segment.start
        gesture.end = segment.start
        gesture.live = sendTouch({ ...segment.start, type: 'begin' })
        gesture.firstMove = true
      } else {
        gesture.firstMove = false
        const completesStep =
          Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y) >=
          distance * fraction - 1e-9
        if (completesStep && gesture.tailFrames > 0) {
          gesture.tailFrames--
        }
        gesture.remaining = {
          x: gesture.remaining.x - (segment.end.x - segment.start.x),
          y: gesture.remaining.y - (segment.end.y - segment.start.y)
        }
        gesture.end = segment.end
        if (gesture.live) {
          sendTouch({ ...segment.end, type: 'move' })
        }
      }
      if (Math.hypot(gesture.remaining.x, gesture.remaining.y) < 1e-9) {
        gesture.moveTimer = null
        gesture.endTimer = window.setTimeout(finish, 80)
      } else {
        gesture.moveTimer = window.setTimeout(advanceWheelGesture, 16)
      }
    },
    [endSegment, finish, sendTouch]
  )

  const cancel = useCallback(() => {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (!gesture) {
      return
    }
    if (gesture.moveTimer !== null) {
      window.clearTimeout(gesture.moveTimer)
    }
    if (gesture.endTimer !== null) {
      window.clearTimeout(gesture.endTimer)
    }
    if (gesture.live) {
      sendTouch({ ...gesture.end, type: 'end' })
    }
  }, [sendTouch])
  useEffect(() => cancel, [cancel])

  const queue = useCallback(
    ({ start, delta }: WheelInput) => {
      let gesture = gestureRef.current
      if (!gesture) {
        const segment = resolveWheelGestureStep(start, delta)
        if (!segment) {
          return
        }
        gesture = {
          start: segment.start,
          end: segment.start,
          remaining: { x: 0, y: 0 },
          live: sendTouch({ ...segment.start, type: 'begin' }),
          moveTimer: null,
          endTimer: null,
          tailFrames: 0,
          firstMove: true
        }
      }
      gesture = {
        ...gesture,
        remaining: {
          x: gesture.remaining.x + delta.x,
          y: gesture.remaining.y + delta.y
        },
        tailFrames: 0
      }
      if (gesture.endTimer !== null) {
        window.clearTimeout(gesture.endTimer)
        gesture.endTimer = null
      }
      if (gesture.moveTimer === null) {
        // UIKit ignores pans whose first move shares the touch-down frame.
        gesture.moveTimer = window.setTimeout(advance, 16)
      }
      gestureRef.current = gesture
    },
    [advance, sendTouch]
  )
  return { cancel, queue }
}
