// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  computeProjectGroupHeaderDropPreview,
  getProjectGroupHeaderDragBucketKey,
  getProjectGroupTabOrderUpdatesForSidebarDrop,
  getSidebarOrderedProjectGroupHeaderIdsByBucket,
  mapSidebarProjectGroupDropIndexToSiblingInsertIndex
} from './project-group-header-drop'
import type { Row } from './worktree-list-groups'
import type { ProjectGroup, Repo } from '../../../../shared/types'

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
  it('uses root for top-level groups', () => {
    expect(getProjectGroupHeaderDragBucketKey(group('root'))).toBe('root')
  })

  it('scopes child groups to their parent bucket', () => {
    const root = group('root')
    const child = group('child', { parentGroupId: root.id })
    const groupsById = new Map([
      [root.id, root],
      [child.id, child]
    ])

    expect(getProjectGroupHeaderDragBucketKey(child, groupsById)).toBe('parent:root')
  })

  it('falls back to root when persisted parent metadata is missing', () => {
    const orphan = group('orphan', { parentGroupId: 'missing' })

    expect(getProjectGroupHeaderDragBucketKey(orphan, new Map([[orphan.id, orphan]]))).toBe('root')
  })
})

describe('getSidebarOrderedProjectGroupHeaderIdsByBucket', () => {
  it('groups Project Group headers by effective parent bucket', () => {
    const rootA = group('root-a')
    const rootB = group('root-b')
    const childA = group('child-a', { parentGroupId: rootA.id })
    const repo = { id: 'repo-a', projectGroupId: rootA.id } as Repo
    const groupsById = new Map([
      [rootA.id, rootA],
      [rootB.id, rootB],
      [childA.id, childA]
    ])
    const rows = [
      {
        type: 'header',
        key: 'project-group:root-a',
        label: 'A',
        count: 0,
        tone: '',
        projectGroup: rootA
      },
      { type: 'header', key: 'repo:repo-a', label: 'repo', count: 0, tone: '', repo },
      {
        type: 'header',
        key: 'project-group:child-a',
        label: 'A child',
        count: 0,
        tone: '',
        projectGroup: childA
      },
      {
        type: 'header',
        key: 'project-group:root-b',
        label: 'B',
        count: 0,
        tone: '',
        projectGroup: rootB
      }
    ] as Row[]

    expect(getSidebarOrderedProjectGroupHeaderIdsByBucket(rows, groupsById)).toEqual(
      new Map([
        ['root', ['root-a', 'root-b']],
        ['parent:root-a', ['child-a']]
      ])
    )
  })
})

describe('mapSidebarProjectGroupDropIndexToSiblingInsertIndex', () => {
  it('keeps upward drops at the same target index after removing the source', () => {
    expect(
      mapSidebarProjectGroupDropIndexToSiblingInsertIndex({
        sidebarDropIndex: 0,
        sourceIndex: 2,
        siblingCount: 2
      })
    ).toBe(0)
  })

  it('shifts downward drops because the source header is removed first', () => {
    expect(
      mapSidebarProjectGroupDropIndexToSiblingInsertIndex({
        sidebarDropIndex: 3,
        sourceIndex: 0,
        siblingCount: 2
      })
    ).toBe(2)
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

  it('does not create a drop slot inside an expanded Project Group section', () => {
    const preview = computeProjectGroupHeaderDropPreview({
      pointerY: 350,
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
      ]
    })

    expect(preview).toBeNull()
  })

  it('uses the whole Project Group section for the final boundary slot', () => {
    const preview = computeProjectGroupHeaderDropPreview({
      pointerY: 400,
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
      ]
    })

    expect(preview).toEqual({ dropIndex: 3, dropIndicatorY: 383 })
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

  it('returns no updates when the drop keeps the group in the same slot', () => {
    const groups = [group('a', { tabOrder: 0 }), group('b', { tabOrder: 1 })]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))

    expect(
      getProjectGroupTabOrderUpdatesForSidebarDrop({
        sidebarProjectGroupHeaderIds: ['a', 'b'],
        draggedGroupId: 'a',
        sidebarDropIndex: 1,
        projectGroupById
      })
    ).toEqual([])
  })
})
