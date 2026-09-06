import { describe, expect, it } from 'vitest'
import {
  createSessionGridWheelGesture,
  isDiscreteWheelEvent,
  type SessionGridWheelSample
} from './session-grid-wheel-gesture'

const STEP_PX = 300
const THRESHOLD_PX = 30

function makeGesture() {
  return createSessionGridWheelGesture({
    intentThresholdPx: THRESHOLD_PX,
    getPositionStepPx: () => STEP_PX
  })
}

/** Feeds a train of deltas `gapMs` apart and returns the moves that came out. */
function feedTrain(
  gesture: ReturnType<typeof makeGesture>,
  deltas: number[],
  opts: { discrete?: boolean; gapMs?: number; startAt?: number } = {}
) {
  const { discrete = false, gapMs = 16, startAt = 1000 } = opts
  const moves: { at: number; newGesture: boolean; offset: number }[] = []
  deltas.forEach((deltaY, i) => {
    const sample: SessionGridWheelSample = { deltaY, discrete, at: startAt + i * gapMs }
    const move = gesture.feed(sample)
    if (move) {
      moves.push({ at: sample.at, ...move })
    }
  })
  return moves
}

describe('isDiscreteWheelEvent', () => {
  it('reads whole wheel ticks as a mouse notch and pixel fractions as a trackpad', () => {
    expect(isDiscreteWheelEvent({ deltaMode: 0, deltaY: 40, wheelDeltaY: -120 })).toBe(true)
    expect(isDiscreteWheelEvent({ deltaMode: 0, deltaY: 100, wheelDeltaY: -240 })).toBe(true)
    expect(isDiscreteWheelEvent({ deltaMode: 0, deltaY: 13, wheelDeltaY: -39 })).toBe(false)
    expect(isDiscreteWheelEvent({ deltaMode: 0, deltaY: 13 })).toBe(false)
    expect(isDiscreteWheelEvent({ deltaMode: 1, deltaY: 3 })).toBe(true)
  })
})

describe('createSessionGridWheelGesture', () => {
  it('moves one position for a trackpad flick, momentum included', () => {
    const gesture = makeGesture()
    // Fingers ramp up and lift; the OS then coasts with decaying deltas for far more travel.
    const fingers = [4, 9, 16, 24, 30, 34]
    const momentum = [32, 29, 25, 21, 17, 13, 10, 8, 6, 4, 3, 2, 1, 1]
    const moves = feedTrain(gesture, [...fingers, ...momentum])
    expect(moves.map((m) => m.offset)).toEqual([0, 1])
    expect(moves[0]?.newGesture).toBe(true)
  })

  it('moves further only once a long drag has travelled a full position', () => {
    const gesture = makeGesture()
    const drag = Array.from({ length: 25 }, () => 20)
    const moves = feedTrain(gesture, drag)
    // 500px of travel: the first position at the threshold, the second a full step later.
    expect(moves.map((m) => m.offset)).toEqual([0, 1, 2])
  })

  it('starts a fresh gesture after a pause and anchors it anew', () => {
    const gesture = makeGesture()
    feedTrain(gesture, [10, 20, 30])
    const later = feedTrain(gesture, [10, 20, 30], { startAt: 2000 })
    expect(later[0]?.newGesture).toBe(true)
    expect(later.map((m) => m.offset)).toEqual([0, 1])
  })

  it('does not let the sparse tail of momentum count as a new intent', () => {
    const gesture = makeGesture()
    const moves = feedTrain(gesture, [3, 2, 1], { startAt: 5000, gapMs: 200 })
    expect(moves.map((m) => m.offset)).toEqual([0, 0, 0])
    expect(moves.every((m) => m.newGesture)).toBe(true)
  })

  it('reads a direction change as intent, never as coasting', () => {
    const gesture = makeGesture()
    const moves = feedTrain(gesture, [40, -40, -40])
    expect(moves.map((m) => m.offset)).toEqual([1, 0, -1])
  })

  it('steps one position per mouse notch, folding a burst into one', () => {
    const gesture = makeGesture()
    const slow = feedTrain(gesture, [40, 40, 40], { discrete: true, gapMs: 200 })
    expect(slow.map((m) => m.offset)).toEqual([1, 1, 1])
    expect(slow.every((m) => m.newGesture)).toBe(true)

    const burst = feedTrain(gesture, [40, 80, 40], { discrete: true, gapMs: 10, startAt: 9000 })
    expect(burst.map((m) => m.offset)).toEqual([1])
  })

  it('keeps a trackpad gesture continuous when one delta lands on a whole tick', () => {
    const gesture = makeGesture()
    const moves = feedTrain(gesture, [10, 20, 40, 20], { discrete: false })
    const collision = gesture.feed({ deltaY: 40, discrete: true, at: 1000 + 4 * 16 })
    expect(moves.map((m) => m.offset)).toEqual([0, 1])
    // One extra 40px of travel is nowhere near a second position.
    expect(collision).toBeNull()
  })
})
