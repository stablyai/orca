// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  applyAllRepoInsertAt,
  computeProjectHeaderDropPreviewAcrossBuckets,
  getProjectGroupOrderForSidebarDrop,
  getProjectHeaderDragBucketKey,
  getSidebarOrderedRepoHeaderIdsByBucket,
  mapSidebarProjectHeaderDropIndexToSiblingInsertIndex,
  mapSidebarRepoDropIndexToAllRepoInsertAt
} from './project-header-drop'
import type { Row } from './worktree-list-groups'
import type { Repo } from '../../../../shared/types'

describe('getProjectHeaderDragBucketKey', () => {
  it('uses ungrouped for repos without a project group', () => {
    expect(getProjectHeaderDragBucketKey({ projectGroupId: undefined })).toBe('ungrouped')
  })

  it('scopes grouped repos to their project group bucket', () => {
    expect(getProjectHeaderDragBucketKey({ projectGroupId: 'group-a' })).toBe('group:group-a')
  })
})

describe('getSidebarOrderedRepoHeaderIdsByBucket', () => {
  it('groups repo headers by project group membership', () => {
    const rows = [
      {
        type: 'header',
        key: 'repo:a',
        label: 'A',
        count: 1,
        tone: 'tone',
        repo: { id: 'a', projectGroupId: 'group-a' }
      },
      {
        type: 'header',
        key: 'repo:b',
        label: 'B',
        count: 1,
        tone: 'tone',
        repo: { id: 'b' }
      }
    ] as Row[]

    expect(getSidebarOrderedRepoHeaderIdsByBucket(rows)).toEqual(
      new Map([
        ['group:group-a', ['a']],
        ['ungrouped', ['b']]
      ])
    )
  })
})

describe('mapSidebarRepoDropIndexToAllRepoInsertAt', () => {
  const sidebar = ['a', 'b', 'c']

  it('maps sidebar start drops onto the first visible repo in the full list', () => {
    expect(mapSidebarRepoDropIndexToAllRepoInsertAt(0, sidebar, ['hidden', 'a', 'b', 'c'])).toBe(1)
  })

  it('maps sidebar end drops onto the slot after the last visible repo', () => {
    expect(mapSidebarRepoDropIndexToAllRepoInsertAt(3, sidebar, ['a', 'hidden', 'b', 'c'])).toBe(4)
  })

  it('maps middle sidebar drops onto the target repo id in the full list', () => {
    expect(mapSidebarRepoDropIndexToAllRepoInsertAt(2, sidebar, ['a', 'hidden', 'b', 'c'])).toBe(3)
  })
})

describe('mapSidebarProjectHeaderDropIndexToSiblingInsertIndex', () => {
  it('keeps upward drops at the same target index after removing the source', () => {
    expect(
      mapSidebarProjectHeaderDropIndexToSiblingInsertIndex({
        sidebarDropIndex: 0,
        sourceIndex: 2,
        siblingCount: 2
      })
    ).toBe(0)
  })

  it('shifts downward drops because the source header is removed first', () => {
    expect(
      mapSidebarProjectHeaderDropIndexToSiblingInsertIndex({
        sidebarDropIndex: 3,
        sourceIndex: 0,
        siblingCount: 2
      })
    ).toBe(2)
  })

  it('maps a drop immediately after the source back to the original slot', () => {
    expect(
      mapSidebarProjectHeaderDropIndexToSiblingInsertIndex({
        sidebarDropIndex: 2,
        sourceIndex: 1,
        siblingCount: 2
      })
    ).toBe(1)
  })
})

describe('applyAllRepoInsertAt', () => {
  it('reorders repos using a full-list insertion index', () => {
    expect(applyAllRepoInsertAt(['hidden', 'a', 'b', 'c'], 'c', 1)).toEqual([
      'hidden',
      'c',
      'a',
      'b'
    ])
  })

  it('returns null for no-op reorders', () => {
    expect(applyAllRepoInsertAt(['a', 'b', 'c'], 'b', 2)).toBeNull()
  })
})

describe('computeProjectHeaderDropPreviewAcrossBuckets', () => {
  it('targets the bucket whose project block contains the pointer', () => {
    const result = computeProjectHeaderDropPreviewAcrossBuckets({
      pointerY: 60,
      containerTop: 0,
      scrollTop: 0,
      repoRects: [
        { repoId: 'a', bucketKey: 'group:1', headerIndex: 0, top: 0, bottom: 28 },
        { repoId: 'b', bucketKey: 'group:2', headerIndex: 0, top: 50, bottom: 78 }
      ],
      groupZones: [
        { bucketKey: 'group:1', top: 0, bottom: 40, projectCount: 1 },
        { bucketKey: 'group:2', top: 45, bottom: 85, projectCount: 1 }
      ]
    })
    expect(result?.targetBucketKey).toBe('group:2')
  })

  it('targets the ungrouped bucket when the pointer is below all groups', () => {
    const result = computeProjectHeaderDropPreviewAcrossBuckets({
      pointerY: 200,
      containerTop: 0,
      scrollTop: 0,
      repoRects: [{ repoId: 'u', bucketKey: 'ungrouped', headerIndex: 0, top: 150, bottom: 178 }],
      groupZones: [{ bucketKey: 'group:1', top: 0, bottom: 40, projectCount: 1 }]
    })
    expect(result?.targetBucketKey).toBe('ungrouped')
  })

  it('appends into a collapsed group whose header contains the pointer', () => {
    const result = computeProjectHeaderDropPreviewAcrossBuckets({
      pointerY: 12,
      containerTop: 0,
      scrollTop: 0,
      repoRects: [],
      groupZones: [{ bucketKey: 'group:1', top: 0, bottom: 24, projectCount: 3 }]
    })
    expect(result).toEqual({
      targetBucketKey: 'group:1',
      dropIndex: 3,
      dropIndicatorY: 0,
      intoGroupId: '1'
    })
  })
})

describe('getProjectGroupOrderForSidebarDrop', () => {
  const repo = (id: string, projectGroupOrder?: number): Repo =>
    ({
      id,
      path: `/${id}`,
      displayName: id,
      badgeColor: '#000',
      addedAt: 0,
      projectGroupOrder
    }) as Repo

  it('uses a midpoint between sibling orders when there is room', () => {
    expect(
      getProjectGroupOrderForSidebarDrop({
        siblings: [repo('a', 0), repo('b', 10)],
        dropIndex: 1
      })
    ).toBe(5)
  })

  it('uses manual repo rank as the fallback for missing sibling orders', () => {
    expect(
      getProjectGroupOrderForSidebarDrop({
        siblings: [repo('a'), repo('c')],
        dropIndex: 1,
        repoOrderRankById: new Map([
          ['a', 0],
          ['b', 1],
          ['c', 2]
        ])
      })
    ).toBe(1000)
  })

  it('keeps a deterministic finite anchor when sibling orders collide', () => {
    expect(
      getProjectGroupOrderForSidebarDrop({
        siblings: [repo('a', 0), repo('b', 0)],
        dropIndex: 1
      })
    ).toBe(1)
  })

  it('assigns an order that sorts before siblings ranked by repo order', () => {
    const order = getProjectGroupOrderForSidebarDrop({
      siblings: [repo('a'), repo('b')],
      dropIndex: 1,
      repoOrderRankById: new Map([
        ['a', 0],
        ['b', 1],
        ['c', 2]
      ])
    })

    expect(order).toBeGreaterThan(0)
    expect(order).toBeLessThan(2000)
  })
})
