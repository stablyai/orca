import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../../../../shared/types'
import {
  findLayoutSiblingOnSplitSide,
  isPaneColumnSplitDropNoOp
} from './pane-column-split-drop-no-op'

function horizontalSplit(firstGroupId: string, secondGroupId: string): TabGroupLayoutNode {
  return {
    type: 'split',
    direction: 'horizontal',
    ratio: 0.5,
    first: { type: 'leaf', groupId: firstGroupId },
    second: { type: 'leaf', groupId: secondGroupId }
  }
}

describe('findLayoutSiblingOnSplitSide', () => {
  const layout = horizontalSplit('group-left', 'group-right')

  it('finds the right sibling when splitting the left column to the right', () => {
    expect(findLayoutSiblingOnSplitSide(layout, 'group-left', 'right')).toBe('group-right')
  })

  it('finds the left sibling when splitting the right column to the left', () => {
    expect(findLayoutSiblingOnSplitSide(layout, 'group-right', 'left')).toBe('group-left')
  })

  it('returns null for split directions that would not target the adjacent sibling', () => {
    expect(findLayoutSiblingOnSplitSide(layout, 'group-left', 'left')).toBeNull()
    expect(findLayoutSiblingOnSplitSide(layout, 'group-right', 'right')).toBeNull()
  })
})

describe('isPaneColumnSplitDropNoOp', () => {
  const layout = horizontalSplit('group-left', 'group-right')

  it('treats splitting the only tab in a group onto itself as a no-op', () => {
    expect(
      isPaneColumnSplitDropNoOp({
        sourceGroupId: 'group-left',
        targetGroupId: 'group-left',
        splitDirection: 'right',
        sourceTabCount: 1,
        layout
      })
    ).toBe(true)
  })

  it('treats dragging the only tab onto the adjacent sibling edge as a no-op', () => {
    expect(
      isPaneColumnSplitDropNoOp({
        sourceGroupId: 'group-right',
        targetGroupId: 'group-left',
        splitDirection: 'right',
        sourceTabCount: 1,
        layout
      })
    ).toBe(true)
    expect(
      isPaneColumnSplitDropNoOp({
        sourceGroupId: 'group-left',
        targetGroupId: 'group-right',
        splitDirection: 'left',
        sourceTabCount: 1,
        layout
      })
    ).toBe(true)
  })

  it('allows splits when the source group would still have other tabs', () => {
    expect(
      isPaneColumnSplitDropNoOp({
        sourceGroupId: 'group-right',
        targetGroupId: 'group-left',
        splitDirection: 'right',
        sourceTabCount: 2,
        layout
      })
    ).toBe(false)
  })
})
