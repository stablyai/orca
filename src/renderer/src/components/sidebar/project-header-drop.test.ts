// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { getLogicalRepoOrderRankById } from '../../../../shared/project-section-order'

import {
  applyAllRepoInsertAt,
  computeProjectHeaderDropPreview,
  getProjectGroupOrderForSidebarDrop,
  getProjectHeaderDragBucketKey,
  getSidebarOrderedRepoHeaderIdsByBucket,
  mapSidebarProjectHeaderDropIndexToSiblingInsertIndex,
  mapSidebarRepoDropIndexToAllRepoInsertAt
} from './project-header-drop'
import type { Row } from '../../../../shared/sidebar-list/row-types'
import type { Repo } from '../../../../shared/repo-types'

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
        repo: { id: 'a', projectGroupId: 'group-a' }
      },
      {
        type: 'header',
        key: 'repo:b',
        label: 'B',
        count: 1,
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

  it("orders a host copy by its project's anchor and skips copies already drawn", () => {
    const repo = (id: string): Repo => ({
      id,
      path: `/${id}`,
      displayName: id,
      badgeColor: '#000000',
      addedAt: 0
    })
    const header = (key: string, fields: Partial<Extract<Row, { type: 'header' }>>): Row => ({
      type: 'header',
      key,
      count: 1,
      icon: { kind: 'project' },
      ...fields
    })
    const rows = [
      header('project:p', { repo: repo('p-ssh'), anchorRepo: repo('p-local'), hostId: 'ssh:b' }),
      header('project:q', { repo: repo('q'), hostId: 'ssh:b' }),
      header('project:p', {
        repo: repo('p-local'),
        anchorRepo: repo('p-local'),
        hostId: 'local',
        repeated: true
      })
    ]

    expect(getSidebarOrderedRepoHeaderIdsByBucket(rows)).toEqual(
      new Map([['ungrouped', ['p-local', 'q']]])
    )
  })
})

describe('getLogicalRepoOrderRankById', () => {
  it('anchors a merged paired-host header to its first persisted occurrence', () => {
    const rankById = getLogicalRepoOrderRankById(['b', 'same', 'c', 'same'])

    expect(rankById).toEqual(
      new Map([
        ['b', 0],
        ['same', 1],
        ['c', 2]
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

describe('computeProjectHeaderDropPreview', () => {
  it('uses row-model header indices instead of mounted subset order', () => {
    const preview = computeProjectHeaderDropPreview({
      pointerY: 105,
      containerTop: 0,
      scrollTop: 0,
      sidebarRepoHeaderIds: ['a', 'b', 'c', 'd', 'e'],
      rects: [
        { repoId: 'b', bucketKey: 'ungrouped', headerIndex: 1, top: 100, bottom: 128 },
        { repoId: 'c', bucketKey: 'ungrouped', headerIndex: 2, top: 200, bottom: 228 },
        { repoId: 'd', bucketKey: 'ungrouped', headerIndex: 3, top: 300, bottom: 328 }
      ]
    })

    expect(preview).toEqual({ dropIndex: 1, dropIndicatorY: 96 })
  })

  it('supports boundary drops at the end of the full sidebar list', () => {
    const preview = computeProjectHeaderDropPreview({
      pointerY: 400,
      containerTop: 0,
      scrollTop: 0,
      sidebarRepoHeaderIds: ['a', 'b', 'c'],
      rects: [
        {
          repoId: 'c',
          bucketKey: 'ungrouped',
          headerIndex: 2,
          top: 300,
          bottom: 328,
          sectionBottom: 380
        }
      ]
    })

    expect(preview).toEqual({ dropIndex: 3, dropIndicatorY: 383 })
  })

  it('snaps a drop inside the last expanded project section to its bottom boundary', () => {
    const INDICATOR_GAP = 4
    const sectionBottom = 380
    const preview = computeProjectHeaderDropPreview({
      pointerY: 350,
      containerTop: 0,
      scrollTop: 0,
      sidebarRepoHeaderIds: ['a', 'b', 'c'],
      rects: [
        {
          repoId: 'c',
          bucketKey: 'ungrouped',
          headerIndex: 2,
          top: 300,
          bottom: 328,
          sectionBottom
        }
      ]
    })

    expect(preview).toEqual({ dropIndex: 3, dropIndicatorY: sectionBottom + INDICATOR_GAP })
  })

  it('snaps a drop between sibling project headers to the nearer boundary', () => {
    const INDICATOR_GAP = 4
    const nextHeaderTop = 220
    const preview = computeProjectHeaderDropPreview({
      pointerY: 150,
      containerTop: 0,
      scrollTop: 0,
      sidebarRepoHeaderIds: ['a', 'b'],
      rects: [
        {
          repoId: 'a',
          bucketKey: 'ungrouped',
          headerIndex: 0,
          top: 100,
          bottom: 128,
          sectionBottom: nextHeaderTop
        },
        { repoId: 'b', bucketKey: 'ungrouped', headerIndex: 1, top: nextHeaderTop, bottom: 248 }
      ]
    })

    expect(preview).toEqual({ dropIndex: 1, dropIndicatorY: nextHeaderTop - INDICATOR_GAP })
  })

  describe('nearest-boundary choice across an interior gap', () => {
    // Estimated section ends can drift from actual header geometry; test snapping on both sides of the gap.
    const INDICATOR_GAP = 4
    const prevSectionBottom = 200
    const nextHeaderTop = 240
    const sectionBottomSlotY = prevSectionBottom + INDICATOR_GAP
    const nextHeaderSlotY = nextHeaderTop - INDICATOR_GAP
    const midpointY = (sectionBottomSlotY + nextHeaderSlotY) / 2
    const gapRects = [
      {
        repoId: 'a',
        bucketKey: 'ungrouped',
        headerIndex: 0,
        top: 100,
        bottom: 128,
        sectionBottom: prevSectionBottom
      },
      {
        repoId: 'b',
        bucketKey: 'ungrouped',
        headerIndex: 1,
        top: nextHeaderTop,
        bottom: 268,
        sectionBottom: 340
      }
    ] as const

    it('snaps to the previous section bottom when the pointer is nearer to it', () => {
      const preview = computeProjectHeaderDropPreview({
        pointerY: sectionBottomSlotY + 1,
        containerTop: 0,
        scrollTop: 0,
        sidebarRepoHeaderIds: ['a', 'b'],
        rects: gapRects.map((rect) => ({ ...rect }))
      })

      expect(preview).toEqual({ dropIndex: 1, dropIndicatorY: sectionBottomSlotY })
    })

    it('snaps to the next header top when the pointer is nearer to it', () => {
      const preview = computeProjectHeaderDropPreview({
        pointerY: nextHeaderSlotY - 1,
        containerTop: 0,
        scrollTop: 0,
        sidebarRepoHeaderIds: ['a', 'b'],
        rects: gapRects.map((rect) => ({ ...rect }))
      })

      expect(preview).toEqual({ dropIndex: 1, dropIndicatorY: nextHeaderSlotY })
    })

    it('breaks the midpoint tie toward the next header boundary', () => {
      const preview = computeProjectHeaderDropPreview({
        pointerY: midpointY, // Equidistant boundaries prefer the next header.
        containerTop: 0,
        scrollTop: 0,
        sidebarRepoHeaderIds: ['a', 'b'],
        rects: gapRects.map((rect) => ({ ...rect }))
      })

      expect(preview).toEqual({ dropIndex: 1, dropIndicatorY: nextHeaderSlotY })
    })
  })

  describe('content bound for the last section', () => {
    const INDICATOR_GAP = 4
    const estimatedSectionBottom = 380
    const lastRects = [
      {
        repoId: 'c',
        bucketKey: 'ungrouped',
        headerIndex: 2,
        top: 300,
        bottom: 328,
        sectionBottom: estimatedSectionBottom
      }
    ] as const
    const lastPreview = (pointerY: number, contentBottom: number) =>
      computeProjectHeaderDropPreview({
        pointerY,
        containerTop: 0,
        scrollTop: 0,
        sidebarRepoHeaderIds: ['a', 'b', 'c'],
        rects: lastRects.map((rect) => ({ ...rect })),
        contentBottom
      })

    it('rejects a drop below the measured content when the estimate overshoots', () => {
      expect(lastPreview(360, 340)).toBeNull()
    })

    it('rejects an edge-zone final drop below measured content when the estimate overshoots', () => {
      // Cross the estimated end while remaining below measured content; the measured bound must win.
      expect(lastPreview(389, 350)).toBeNull()
    })

    it('still snaps within the measured content when the estimate overshoots', () => {
      expect(lastPreview(335, 340)).toEqual({
        dropIndex: 3,
        dropIndicatorY: estimatedSectionBottom + INDICATOR_GAP
      })
    })

    it('snaps within the measured content when actual content undershoots the estimate', () => {
      expect(lastPreview(360, 420)).toEqual({
        dropIndex: 3,
        dropIndicatorY: estimatedSectionBottom + INDICATOR_GAP
      })
    })
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

  it('moves duplicate host occurrences as one stable logical-project block', () => {
    expect(applyAllRepoInsertAt(['b', 'same', 'c', 'same'], 'same', 0)).toEqual([
      'same',
      'same',
      'b',
      'c'
    ])
  })

  it('returns null for no-op reorders', () => {
    expect(applyAllRepoInsertAt(['a', 'b', 'c'], 'b', 2)).toBeNull()
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
