import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { getSeamTabRowStarts } from './seam-tab-row-starts'

const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })

describe('getSeamTabRowStarts', () => {
  it('finds the tab row of every group stacked along the seam, not just the top one', () => {
    const second: TabGroupLayoutNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.25,
      first: leaf('upper'),
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: leaf('mid'),
        second: leaf('low')
      }
    }
    expect(getSeamTabRowStarts(second)).toEqual([0, 0.25, 0.625])
  })

  it('skips groups whose left edge is away from the seam', () => {
    const second: TabGroupLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.4,
        first: leaf('a'),
        second: leaf('b')
      },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.8,
        first: leaf('c'),
        second: leaf('d')
      }
    }
    expect(getSeamTabRowStarts(second)).toEqual([0, 0.4])
  })
})
