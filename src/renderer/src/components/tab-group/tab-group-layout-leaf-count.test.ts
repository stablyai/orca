import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../../../../shared/types'
import { countLayoutLeaves } from './tab-group-layout-leaf-count'

describe('countLayoutLeaves', () => {
  it('counts a single leaf as one', () => {
    const layout: TabGroupLayoutNode = { type: 'leaf', groupId: 'a' }
    expect(countLayoutLeaves(layout)).toBe(1)
  })

  it('counts a two-leaf split as two', () => {
    const layout: TabGroupLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'a' },
      second: { type: 'leaf', groupId: 'b' }
    }
    expect(countLayoutLeaves(layout)).toBe(2)
  })

  it('counts leaves in a nested split tree', () => {
    const layout: TabGroupLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'a' },
      second: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', groupId: 'b' },
        second: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'c' },
          second: { type: 'leaf', groupId: 'd' }
        }
      }
    }
    expect(countLayoutLeaves(layout)).toBe(4)
  })
})
