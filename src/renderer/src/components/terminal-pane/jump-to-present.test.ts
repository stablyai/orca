import { describe, expect, it } from 'vitest'
import { getPaneJumpState, SCROLLED_AWAY_THRESHOLD } from './jump-to-present'

describe('getPaneJumpState', () => {
  it('stays hidden when the viewport is already at the live bottom', () => {
    expect(getPaneJumpState({ baseY: 24, viewportY: 24 })).toEqual({
      showJumpToPresent: false,
      hiddenLineCount: 0
    })
  })

  it('stays hidden within the scroll threshold', () => {
    expect(getPaneJumpState({ baseY: 24, viewportY: 24 - SCROLLED_AWAY_THRESHOLD })).toEqual({
      showJumpToPresent: false,
      hiddenLineCount: SCROLLED_AWAY_THRESHOLD
    })
  })

  it('shows once the viewport is meaningfully above the bottom', () => {
    expect(getPaneJumpState({ baseY: 24, viewportY: 24 - SCROLLED_AWAY_THRESHOLD - 1 })).toEqual({
      showJumpToPresent: true,
      hiddenLineCount: SCROLLED_AWAY_THRESHOLD + 1
    })
  })

  it('clamps negative hidden-line counts caused by transient viewport races', () => {
    expect(getPaneJumpState({ baseY: 8, viewportY: 12 })).toEqual({
      showJumpToPresent: false,
      hiddenLineCount: 0
    })
  })
})
