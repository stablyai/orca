// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  computeGroupHeaderDropPreview,
  getTabOrderForGroupDrop,
  getSiblingGroupIdsByParent,
  type GroupHeaderDragRect
} from './group-header-drop'
import type { ProjectGroup } from '../../../../shared/types'

function makeGroup(id: string, tabOrder: number): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

describe('getTabOrderForGroupDrop', () => {
  it('returns 0 for an empty sibling list', () => {
    expect(getTabOrderForGroupDrop({ siblings: [], dropIndex: 0 })).toBe(0)
  })
  it('places below the first sibling when dropping at the start', () => {
    const siblings = [makeGroup('a', 0), makeGroup('b', 1)]
    expect(getTabOrderForGroupDrop({ siblings, dropIndex: 0 })).toBe(-1)
  })
  it('places between two siblings', () => {
    const siblings = [makeGroup('a', 0), makeGroup('b', 2)]
    expect(getTabOrderForGroupDrop({ siblings, dropIndex: 1 })).toBe(1)
  })
  it('places above the last sibling when dropping at the end', () => {
    const siblings = [makeGroup('a', 0), makeGroup('b', 2)]
    expect(getTabOrderForGroupDrop({ siblings, dropIndex: 2 })).toBe(3)
  })
})

describe('computeGroupHeaderDropPreview', () => {
  const rects: GroupHeaderDragRect[] = [
    { groupId: 'a', siblingIndex: 0, top: 0, bottom: 28 },
    { groupId: 'b', siblingIndex: 1, top: 100, bottom: 128 }
  ]
  it('drops before the second group when the pointer is in its top half', () => {
    const preview = computeGroupHeaderDropPreview({
      pointerY: 105,
      containerTop: 0,
      scrollTop: 0,
      rects,
      siblingGroupIds: ['a', 'b']
    })
    expect(preview?.dropIndex).toBe(1)
  })
  it('returns null when there are no sibling ids', () => {
    expect(
      computeGroupHeaderDropPreview({
        pointerY: 105,
        containerTop: 0,
        scrollTop: 0,
        rects,
        siblingGroupIds: []
      })
    ).toBeNull()
  })
})

describe('getSiblingGroupIdsByParent', () => {
  it('buckets group headers by parent in row order', () => {
    const map = getSiblingGroupIdsByParent([
      {
        type: 'header',
        key: 'project-group:a',
        label: 'a',
        count: 1,
        tone: '',
        projectGroup: { id: 'a', name: 'a', parentGroupId: null, tabOrder: 0 } as never
      },
      {
        type: 'header',
        key: 'project-group:b',
        label: 'b',
        count: 1,
        tone: '',
        projectGroup: { id: 'b', name: 'b', parentGroupId: null, tabOrder: 1 } as never
      }
    ] as never)
    expect(map.get(null)).toEqual(['a', 'b'])
  })
})
