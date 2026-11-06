// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  computeProjectGroupHeaderDropPreview,
  getProjectGroupHeaderDragBucketKey,
  getProjectGroupTabOrderUpdatesForSidebarDrop
} from './project-group-header-drop'

import type { ProjectGroup } from '../../../../../../shared/project-group-types'

function group(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('getProjectGroupHeaderDragBucketKey', () => {
  it('falls back to root when persisted parent metadata is missing', () => {
    const orphan = group('orphan', { parentGroupId: 'missing' })

    expect(getProjectGroupHeaderDragBucketKey(orphan, new Map([[orphan.id, orphan]]))).toBe('root')
  })
})

describe('computeProjectGroupHeaderDropPreview', () => {
  it('uses row-model header indices instead of mounted subset order', () => {
    const preview = computeProjectGroupHeaderDropPreview({
      pointerY: 105,
      containerTop: 0,
      scrollTop: 0,
      sidebarProjectGroupHeaderIds: ['a', 'b', 'c', 'd', 'e'],
      rects: [
        { groupId: 'b', bucketKey: 'root', headerIndex: 1, top: 100, bottom: 128 },
        { groupId: 'c', bucketKey: 'root', headerIndex: 2, top: 200, bottom: 228 },
        { groupId: 'd', bucketKey: 'root', headerIndex: 3, top: 300, bottom: 328 }
      ]
    })

    expect(preview).toEqual({ dropIndex: 1, dropIndicatorY: 96 })
  })

  it('rejects a drop below the measured content when the estimated section overshoots', () => {
    const preview = computeProjectGroupHeaderDropPreview({
      pointerY: 360,
      containerTop: 0,
      scrollTop: 0,
      sidebarProjectGroupHeaderIds: ['a', 'b', 'c'],
      rects: [
        {
          groupId: 'c',
          bucketKey: 'root',
          headerIndex: 2,
          top: 300,
          bottom: 328,
          sectionBottom: 380
        }
      ],
      // Estimate ends at 380 but the list renders to 340; 360 is below content.
      contentBottom: 340
    })

    expect(preview).toBeNull()
  })
})

describe('getProjectGroupTabOrderUpdatesForSidebarDrop', () => {
  it('reindexes sibling groups so duplicate legacy tabOrder values can move between siblings', () => {
    const groups = [group('a'), group('b'), group('c'), group('d')]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))

    expect(
      getProjectGroupTabOrderUpdatesForSidebarDrop({
        sidebarProjectGroupHeaderIds: ['a', 'b', 'c', 'd'],
        draggedGroupId: 'd',
        sidebarDropIndex: 2,
        projectGroupById
      })
    ).toEqual([
      { groupId: 'b', tabOrder: 1 },
      { groupId: 'd', tabOrder: 2 },
      { groupId: 'c', tabOrder: 3 }
    ])
  })
})
