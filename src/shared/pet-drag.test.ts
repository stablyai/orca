import { describe, expect, it } from 'vitest'
import {
  facingForDragAnimation,
  nextPetDragAnimation,
  PET_DRAG_DIRECTION_THRESHOLD_PX,
  type PetDragAnimation
} from './pet-drag'

const T = PET_DRAG_DIRECTION_THRESHOLD_PX

describe('nextPetDragAnimation', () => {
  it('commits to a direction once travel passes the threshold', () => {
    expect(nextPetDragAnimation(null, T)).toEqual({
      animation: 'running-right',
      accepted: true
    })
    expect(nextPetDragAnimation(null, -T)).toEqual({
      animation: 'running-left',
      accepted: true
    })
  })

  it('holds the current direction below the threshold rather than clearing it', () => {
    // The pet must not flicker back to "no direction" between frames of a
    // steady drag — sub-threshold jitter keeps whatever it was already doing.
    expect(nextPetDragAnimation('running-right', T - 1)).toEqual({
      animation: 'running-right',
      accepted: false
    })
    expect(nextPetDragAnimation('running-left', 0)).toEqual({
      animation: 'running-left',
      accepted: false
    })
  })

  it('lets a slow drag accumulate to a turn instead of resetting its baseline', () => {
    // The regression this guards: if the caller advanced its baseline on every
    // move, a drag slower than the threshold per frame would never turn at all.
    let animation: PetDragAnimation = 'running-left'
    let baseline = 0
    let dx = 0
    for (let frame = 0; frame < 10; frame += 1) {
      dx += 1
      const turn = nextPetDragAnimation(animation, dx - baseline)
      if (turn.accepted) {
        baseline = dx
        animation = turn.animation
      }
    }
    expect(animation).toBe('running-right')
  })

  it('is symmetric at the boundary in both directions', () => {
    expect(nextPetDragAnimation(null, T).accepted).toBe(true)
    expect(nextPetDragAnimation(null, -T).accepted).toBe(true)
    expect(nextPetDragAnimation(null, T - 0.001).accepted).toBe(false)
    expect(nextPetDragAnimation(null, -(T - 0.001)).accepted).toBe(false)
  })
})

describe('facingForDragAnimation', () => {
  it('projects a committed drag direction onto the phone’s two facings', () => {
    expect(facingForDragAnimation('running-right', 'left')).toBe('right')
    expect(facingForDragAnimation('running-left', 'right')).toBe('left')
  })

  it('keeps the previous facing while the drag has not committed', () => {
    // A grabbed pet that has not moved yet must not snap to a default facing —
    // it keeps looking the way it was walking.
    expect(facingForDragAnimation(null, 'left')).toBe('left')
    expect(facingForDragAnimation(null, 'right')).toBe('right')
  })
})
