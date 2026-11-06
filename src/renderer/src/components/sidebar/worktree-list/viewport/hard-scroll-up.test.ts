import { describe, expect, it } from 'vitest'
import {
  createHardScrollUpDetectorState,
  HARD_SCROLL_UP,
  reduceHardScrollUpOnScroll,
  reduceHardScrollUpOnWheel
} from './hard-scroll-up'

const DEEP = {
  scrollTop: 1200,
  maxScroll: 4000
} as const

const SHORT_LIST = {
  scrollTop: 200,
  maxScroll: 200
} as const

describe('reduceHardScrollUpOnWheel', () => {
  it('stays hidden for short lists and near-top viewports', () => {
    let state = createHardScrollUpDetectorState()
    for (let i = 0; i < 10; i += 1) {
      state = reduceHardScrollUpOnWheel(state, {
        ...SHORT_LIST,
        t: i * 16,
        deltaY: -120
      })
    }
    expect(state.visible).toBe(false)

    state = createHardScrollUpDetectorState()
    for (let i = 0; i < 10; i += 1) {
      state = reduceHardScrollUpOnWheel(state, {
        scrollTop: 20,
        maxScroll: 4000,
        t: i * 16,
        deltaY: -120
      })
    }
    expect(state.visible).toBe(false)
  })

  it('does not show on gentle upward scrolling', () => {
    let state = createHardScrollUpDetectorState()
    // Small trackpad ticks — effort exists but is not "hard".
    for (let i = 0; i < 8; i += 1) {
      state = reduceHardScrollUpOnWheel(state, {
        ...DEEP,
        t: i * 40,
        deltaY: -18
      })
    }
    expect(state.visible).toBe(false)
  })

  it('shows after a sustained hard upward wheel burst', () => {
    let state = createHardScrollUpDetectorState()
    for (let i = 0; i < 5; i += 1) {
      state = reduceHardScrollUpOnWheel(state, {
        ...DEEP,
        scrollTop: DEEP.scrollTop - i * 40,
        t: 1000 + i * 40,
        deltaY: -160
      })
    }
    expect(state.visible).toBe(true)
    expect(state.lastIntentAt).toBe(1000 + 4 * 40)
  })

  it('shows after a trackpad fling (high peak + enough total)', () => {
    let state = createHardScrollUpDetectorState()
    const deltas = [-40, -120, -200, -80]
    deltas.forEach((deltaY, i) => {
      state = reduceHardScrollUpOnWheel(state, {
        ...DEEP,
        t: 2000 + i * 30,
        deltaY
      })
    })
    expect(state.visible).toBe(true)
  })

  it('clears when the user reaches the top', () => {
    let state = createHardScrollUpDetectorState()
    for (let i = 0; i < 5; i += 1) {
      state = reduceHardScrollUpOnWheel(state, {
        ...DEEP,
        t: i * 40,
        deltaY: -160
      })
    }
    expect(state.visible).toBe(true)

    state = reduceHardScrollUpOnWheel(state, {
      scrollTop: 10,
      maxScroll: 4000,
      t: 400,
      deltaY: -20
    })
    expect(state.visible).toBe(false)
  })
})

describe('reduceHardScrollUpOnScroll', () => {
  it('shows when scrollbar drag velocity is hard upward', () => {
    let state = createHardScrollUpDetectorState()
    state = reduceHardScrollUpOnScroll(state, {
      scrollTop: 1500,
      maxScroll: 4000,
      t: 0
    })
    state = reduceHardScrollUpOnScroll(state, {
      scrollTop: 1000,
      maxScroll: 4000,
      t: HARD_SCROLL_UP.velocitySustainMs + 90
    })
    expect(state.visible).toBe(true)
  })

  it('ignores slow scrollbar movement', () => {
    let state = createHardScrollUpDetectorState()
    state = reduceHardScrollUpOnScroll(state, {
      scrollTop: 1500,
      maxScroll: 4000,
      t: 0
    })
    state = reduceHardScrollUpOnScroll(state, {
      scrollTop: 1450,
      maxScroll: 4000,
      t: 300
    })
    expect(state.visible).toBe(false)
  })
})
