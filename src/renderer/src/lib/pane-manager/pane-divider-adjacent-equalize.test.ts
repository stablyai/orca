import { describe, expect, it } from 'vitest'
import {
  EQUALIZED_ADJACENT_PANE_FLEX,
  equalizeAdjacentDividerPanes,
  equalizedAdjacentPaneFlex
} from './pane-divider-adjacent-equalize'

function makePane(flex = '2 1 0%'): HTMLElement {
  return { style: { flex } } as unknown as HTMLElement
}

describe('equalizedAdjacentPaneFlex', () => {
  it('preserves the pair’s combined flex weight', () => {
    // 3 + 1 = 4 → each half is 2 (not 1, which would drop pair weight to 2)
    expect(equalizedAdjacentPaneFlex('3 1 0%', '1 1 0%')).toBe('2 1 0%')
    expect(equalizedAdjacentPaneFlex('5 1 0%', '1 1 0%')).toBe('3 1 0%')
  })

  it('keeps unit weight when both sides are already equal at 1', () => {
    expect(equalizedAdjacentPaneFlex('1 1 0%', '1 1 0%')).toBe(EQUALIZED_ADJACENT_PANE_FLEX)
  })
})

describe('equalizeAdjacentDividerPanes', () => {
  it('sets both neighbors to half of their combined flex weight', () => {
    const prev = makePane('3 1 0%')
    const next = makePane('1 1 0%')

    expect(equalizeAdjacentDividerPanes(prev, next)).toBe(true)
    expect(prev.style.flex).toBe('2 1 0%')
    expect(next.style.flex).toBe('2 1 0%')
  })

  it('returns false without mutating when a neighbor is missing', () => {
    const prev = makePane('2 1 0%')
    expect(equalizeAdjacentDividerPanes(prev, null)).toBe(false)
    expect(equalizeAdjacentDividerPanes(null, prev)).toBe(false)
    expect(prev.style.flex).toBe('2 1 0%')
  })
})
