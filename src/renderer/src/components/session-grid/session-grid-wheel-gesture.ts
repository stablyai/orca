/**
 * Wheel gestures on a snapping grid: which device produced them, and how many
 * positions one gesture should move. A mouse notch is one position; a trackpad
 * gesture is one position for a flick and more only for a long deliberate drag.
 */

// Chromium reports a mouse notch as whole 120ths in the legacy wheelDeltaY; trackpads report pixel fractions.
const WHEEL_TICK_UNIT = 120
/** A gap this long between events ends a gesture; trackpad momentum keeps events closer until it has all but died. */
export const WHEEL_GESTURE_GAP_MS = 150
// Notches this close together are one flick of the wheel, not one position each.
const DISCRETE_STEP_COALESCE_MS = 40

type WheelDeltaSource = Pick<WheelEvent, 'deltaMode' | 'deltaY'> & { wheelDeltaY?: number }

export function isDiscreteWheelEvent(event: WheelDeltaSource): boolean {
  if (event.deltaMode !== 0) {
    return true
  }
  const ticks = event.wheelDeltaY
  return typeof ticks === 'number' && ticks !== 0 && ticks % WHEEL_TICK_UNIT === 0
}

export type SessionGridWheelSample = { deltaY: number; discrete: boolean; at: number }

/** `offset` counts from where the grid sat when the gesture began; `newGesture` asks the caller to capture that anchor. */
export type SessionGridWheelMove = { newGesture: boolean; offset: number }

export function createSessionGridWheelGesture(config: {
  intentThresholdPx: number
  getPositionStepPx: () => number
}): { feed: (sample: SessionGridWheelSample) => SessionGridWheelMove | null } {
  let lastAt = Number.NEGATIVE_INFINITY
  let lastStepAt = Number.NEGATIVE_INFINITY
  let discrete = false
  let counted = 0
  let previousMagnitude = 0
  let previousDirection = 0
  let offset = 0

  const feed = (sample: SessionGridWheelSample): SessionGridWheelMove | null => {
    if (sample.deltaY === 0) {
      return null
    }
    // A trackpad delta can land on a whole tick by chance, so a gesture keeps the class it started with; only a mouse gesture yields to pixel deltas.
    const newGesture = sample.at - lastAt > WHEEL_GESTURE_GAP_MS || (discrete && !sample.discrete)
    lastAt = sample.at
    if (newGesture) {
      discrete = sample.discrete
      counted = 0
      previousMagnitude = 0
      previousDirection = 0
      offset = 0
    }

    if (discrete) {
      if (
        sample.at - lastStepAt < DISCRETE_STEP_COALESCE_MS ||
        Math.abs(sample.deltaY) < config.intentThresholdPx
      ) {
        return null
      }
      lastStepAt = sample.at
      // Each notch is its own gesture: one position on from wherever the last notch sent the grid.
      return { newGesture: true, offset: Math.sign(sample.deltaY) }
    }

    const direction = Math.sign(sample.deltaY)
    const magnitude = Math.abs(sample.deltaY)
    // Momentum decays monotonically: a delta smaller than the last in the same direction is the OS coasting, not the fingers.
    const coasting = direction === previousDirection && magnitude < previousMagnitude
    previousDirection = direction
    previousMagnitude = magnitude
    if (!coasting) {
      counted += sample.deltaY
    }

    const distance = Math.abs(counted)
    let next = 0
    if (distance >= config.intentThresholdPx) {
      const stepPx = config.getPositionStepPx()
      // The first position costs only the intent threshold; every further one costs a full position of travel.
      const extra = stepPx > 0 ? Math.floor((distance - config.intentThresholdPx) / stepPx) : 0
      next = Math.sign(counted) * (1 + extra)
    }
    if (!newGesture && next === offset) {
      return null
    }
    offset = next
    return { newGesture, offset }
  }

  return { feed }
}
