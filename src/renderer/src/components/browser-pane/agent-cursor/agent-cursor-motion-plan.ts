import {
  clamp,
  planCursorPath,
  type CursorBounds,
  type CursorPath,
  type CursorPoint
} from './agent-cursor-path'
import { POSITION, PROGRESS_DAMPING, Spring, type SpringConfig } from './agent-cursor-spring'

// Short hops slide straight with a squash and lean; longer moves fly a curved path.
const SCOOT_MAX_PX = 196
const LEAN_DEG = 70

export type CursorMotion =
  | {
      mode: 'path'
      path: CursorPath
      end: CursorPoint
      progress: Spring
      position: SpringConfig
    }
  | {
      mode: 'scoot'
      start: CursorPoint
      end: CursorPoint
      axisDeg: number
      leanDeg: number
    }

export function planCursorMotion(
  from: CursorPoint,
  to: CursorPoint,
  bounds: CursorBounds
): CursorMotion | null {
  const travel = Math.hypot(to.x - from.x, to.y - from.y)
  if (travel < 0.5) {
    return null
  }
  if (travel <= SCOOT_MAX_PX) {
    const dx = (to.x - from.x) / travel
    const dy = (to.y - from.y) / travel
    return {
      mode: 'scoot',
      start: { ...from },
      end: { ...to },
      axisDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
      leanDeg: clamp(dx * 0.75 - dy * 0.62, -1, 1) * LEAN_DEG
    }
  }
  const planned = planCursorPath(from, to, bounds)
  const progress = new Spring(0, { response: planned.response, damping: PROGRESS_DAMPING })
  progress.target = 1
  // Position chases the path point tightly so the curve, not the chase, shapes the flight.
  const response = clamp(planned.response * 0.18, 0.035, 0.12)
  return {
    mode: 'path',
    path: planned.path,
    end: { ...to },
    progress,
    position: { response, damping: POSITION.damping }
  }
}
