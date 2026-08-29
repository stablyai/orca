import { describe, expect, it } from 'vitest'
import {
  createHardScrollUpDetectorState,
  HARD_SCROLL_UP,
  normalizeWheelDeltaY,
  reduceHardScrollUpOnDismiss,
  reduceHardScrollUpOnIdle,
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

describe('normalizeWheelDeltaY', () => {
  it('keeps pixel mode and expands line/page modes', () => {
    expect(normalizeWheelDeltaY(-40, 0)).toBe(-40)
    expect(normalizeWheelDeltaY(-3, 1)).toBe(-48)
    expect(normalizeWheelDeltaY(-1, 2)).toBe(-600)
  })
})

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
    // ~5 hard ticks in < window: 5 * 160 = 800 >= hardTotalDeltaPx
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

  it('hides on significant downward scroll', () => {
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
      ...DEEP,
      t: 500,
      deltaY: 80
    })
    expect(state.visible).toBe(false)
    expect(state.wheelSamples).toEqual([])
    expect(state.scrollSamples).toEqual([])
  })

  it('hides after cumulative small downward wheel events', () => {
    let state = createHardScrollUpDetectorState()
    for (let i = 0; i < 5; i += 1) {
      state = reduceHardScrollUpOnWheel(state, {
        ...DEEP,
        t: i * 40,
        deltaY: -160
      })
    }

    state = reduceHardScrollUpOnWheel(state, { ...DEEP, t: 220, deltaY: 20 })
    state = reduceHardScrollUpOnWheel(state, { ...DEEP, t: 260, deltaY: 20 })
    expect(state.visible).toBe(true)
    expect(state.lastIntentAt).toBe(160)

    state = reduceHardScrollUpOnWheel(state, { ...DEEP, t: 300, deltaY: 20 })
    expect(state).toEqual(createHardScrollUpDetectorState())
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
    // Drop 500px in 250ms => 2000 px/s
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

  it('hides after cumulative small downward scrollbar movement', () => {
    let state = createHardScrollUpDetectorState()
    state = reduceHardScrollUpOnScroll(state, { ...DEEP, scrollTop: 1500, t: 0 })
    state = reduceHardScrollUpOnScroll(state, { ...DEEP, scrollTop: 1000, t: 250 })
    expect(state.visible).toBe(true)

    state = reduceHardScrollUpOnScroll(state, { ...DEEP, scrollTop: 1020, t: 280 })
    state = reduceHardScrollUpOnScroll(state, { ...DEEP, scrollTop: 1040, t: 310 })
    expect(state.visible).toBe(true)
    expect(state.lastIntentAt).toBe(250)

    state = reduceHardScrollUpOnScroll(state, { ...DEEP, scrollTop: 1060, t: 340 })
    expect(state).toEqual(createHardScrollUpDetectorState())
  })
})

describe('reduceHardScrollUpOnIdle / dismiss', () => {
  it('auto-hides after idle while still deep', () => {
    let state = createHardScrollUpDetectorState()
    for (let i = 0; i < 5; i += 1) {
      state = reduceHardScrollUpOnWheel(state, {
        ...DEEP,
        t: i * 40,
        deltaY: -160
      })
    }
    expect(state.visible).toBe(true)

    state = reduceHardScrollUpOnIdle(state, {
      ...DEEP,
      t: state.lastIntentAt + HARD_SCROLL_UP.hideAfterIdleMs - 1
    })
    expect(state.visible).toBe(true)

    state = reduceHardScrollUpOnIdle(state, {
      ...DEEP,
      t: state.lastIntentAt + HARD_SCROLL_UP.hideAfterIdleMs
    })
    expect(state.visible).toBe(false)
  })

  it('hides on later non-intent scroll after the idle deadline (scroll spam must not extend)', () => {
    let state = createHardScrollUpDetectorState()
    for (let i = 0; i < 5; i += 1) {
      state = reduceHardScrollUpOnWheel(state, {
        ...DEEP,
        t: 1000 + i * 40,
        deltaY: -160
      })
    }
    const intentAt = state.lastIntentAt
    expect(state.visible).toBe(true)

    // Tiny non-intent scrolls after the deadline must still clear visibility.
    state = reduceHardScrollUpOnScroll(state, {
      scrollTop: DEEP.scrollTop - 2,
      maxScroll: DEEP.maxScroll,
      t: intentAt + HARD_SCROLL_UP.hideAfterIdleMs + 10
    })
    expect(state.visible).toBe(false)
  })

  it('dismiss resets state', () => {
    let state = createHardScrollUpDetectorState()
    for (let i = 0; i < 5; i += 1) {
      state = reduceHardScrollUpOnWheel(state, {
        ...DEEP,
        t: i * 40,
        deltaY: -160
      })
    }
    state = reduceHardScrollUpOnDismiss(state)
    expect(state).toEqual(createHardScrollUpDetectorState())
  })
})
