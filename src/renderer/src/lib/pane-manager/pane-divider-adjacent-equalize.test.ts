import { describe, expect, it } from 'vitest'
import {
  EQUALIZED_ADJACENT_PANE_FLEX,
  equalizeAdjacentDividerPanes
} from './pane-divider-adjacent-equalize'

function makePane(flex = '2 1 0%'): HTMLElement {
  return { style: { flex } } as unknown as HTMLElement
}

describe('equalizeAdjacentDividerPanes', () => {
  it('sets both neighbors to equal flex', () => {
    const prev = makePane('3 1 0%')
    const next = makePane('1 1 0%')

    expect(equalizeAdjacentDividerPanes(prev, next)).toBe(true)
    expect(prev.style.flex).toBe(EQUALIZED_ADJACENT_PANE_FLEX)
    expect(next.style.flex).toBe(EQUALIZED_ADJACENT_PANE_FLEX)
  })

  it('returns false without mutating when a neighbor is missing', () => {
    const prev = makePane('2 1 0%')
    expect(equalizeAdjacentDividerPanes(prev, null)).toBe(false)
    expect(equalizeAdjacentDividerPanes(null, prev)).toBe(false)
    expect(prev.style.flex).toBe('2 1 0%')
  })
})
