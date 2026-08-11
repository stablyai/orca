// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  applyAllRepoInsertAt,
  computeProjectHeaderDropPreview,
  getProjectHeaderDragSectionHeight,
  getLogicalRepoOrderRankById,
  getProjectGroupOrderForSidebarDrop,
  getProjectHeaderDragBucketKey,
  getSidebarOrderedRepoHeaderIdsByBucket,
  mapSidebarProjectHeaderDropIndexToSiblingInsertIndex,
  mapSidebarRepoDropIndexToAllRepoInsertAt,
  measureProjectHeaderDragRects
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
  it('uses the next mounted sibling as the project section boundary', () => {
    const container = document.createElement('div')
    container.getBoundingClientRect = () => new DOMRect(0, 0, 100, 500)
    const appendHeader = (repoId: string, index: number, top: number, sectionBottom: number) => {
      const header = document.createElement('div')
      header.setAttribute('data-repo-header-id', repoId)
      header.setAttribute('data-repo-header-bucket', 'ungrouped')
      header.setAttribute('data-repo-header-index', String(index))
      header.setAttribute('data-repo-header-section-end', String(sectionBottom))
      header.getBoundingClientRect = () => new DOMRect(0, top, 100, 28)
      container.append(header)
    }
    appendHeader('a', 0, 100, 600)
    appendHeader('b', 1, 244, 700)

    expect(measureProjectHeaderDragRects(container, 'ungrouped')[0]?.sectionBottom).toBe(244)
  })

  it('uses the measured expanded project section height', () => {
    expect(
      getProjectHeaderDragSectionHeight(
        [
          {
            repoId: 'a',
            bucketKey: 'ungrouped',
            headerIndex: 0,
            top: 100,
            bottom: 128,
            sectionBottom: 276
          }
        ],
        'a'
      )
    ).toBe(176)
  })

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
      ],
      draggedRepoId: 'd',
      draggedSectionHeight: 96
    })

    // 'd' (index 3) moves back to index 1; the sections it jumps over, 'b' and
    // 'c', each shift down by its full height while it is above them.
    expect(preview?.dropIndex).toBe(1)
    expect(Object.fromEntries(preview!.previewOffsetsByRepoId)).toEqual({ b: 96, c: 96 })
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
      ],
      draggedRepoId: 'a',
      draggedSectionHeight: 28
    })

    // 'a' (index 0) moves to the end; 'b' and 'c' each shift up by its section
    // height to close the gap it leaves behind.
    expect(preview?.dropIndex).toBe(3)
    expect(preview?.dropPlaceholderY).toBe(352)
    expect(Object.fromEntries(preview!.previewOffsetsByRepoId)).toEqual({ b: -28, c: -28 })
  })

  it('anchors an upward placeholder at the target slot without assuming equal heights', () => {
    const preview = computeProjectHeaderDropPreview({
      pointerY: 105,
      containerTop: 0,
      scrollTop: 0,
      sidebarRepoHeaderIds: ['a', 'b', 'c'],
      rects: [
        { repoId: 'a', bucketKey: 'ungrouped', headerIndex: 0, top: 100, bottom: 128 },
        { repoId: 'b', bucketKey: 'ungrouped', headerIndex: 1, top: 260, bottom: 288 },
        { repoId: 'c', bucketKey: 'ungrouped', headerIndex: 2, top: 340, bottom: 368 }
      ],
      draggedRepoId: 'c',
      draggedSectionHeight: 80
    })

    expect(preview?.dropPlaceholderY).toBe(100)
  })

  it('snaps a drop inside the last expanded project section to its bottom boundary', () => {
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
      ],
      draggedRepoId: 'b',
      draggedSectionHeight: 28
    })

    // Only boundary available is 'c's section bottom → drop after 'c' (slot 3).
    // 'b' (index 1) moves past 'c', which shifts up by its section height.
    expect(preview?.dropIndex).toBe(3)
    expect(Object.fromEntries(preview!.previewOffsetsByRepoId)).toEqual({ c: -28 })
  })

  it('snaps a drop between sibling project headers to the nearer boundary', () => {
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
      ],
      draggedRepoId: 'a',
      draggedSectionHeight: 28
    })

    // pointerY 150 sits in 'a's body; nearer boundary is 'b's top (216 vs 224).
    // With only two headers, dropIndex 1 is 'a's own post-removal slot: no-op.
    expect(preview?.dropIndex).toBe(1)
    expect(preview?.dropPlaceholderY).toBe(100)
    expect(preview?.dropPlaceholderHeight).toBe(28)
    expect(Object.fromEntries(preview!.previewOffsetsByRepoId)).toEqual({})
  })

  describe('nearest-boundary choice across an interior gap', () => {
    // The gap models estimate-vs-actual drift: sectionBottom is an estimated
    // row offset (worktree-header-section-boundaries.ts, no virtualizer gap:6 or
    // measured sizes) while the next header's top is actual vItem.start geometry,
    // so they diverge in tall sections. Near the real boundary the pointer snaps
    // to actual geometry (beforeNext); the estimate governs only deep-body drops.
    const INDICATOR_GAP = 4
    const prevSectionBottom = 200
    const nextHeaderTop = 240
    const sectionBottomSlotY = prevSectionBottom + INDICATOR_GAP // 204
    const nextHeaderSlotY = nextHeaderTop - INDICATOR_GAP // 236
    const midpointY = (sectionBottomSlotY + nextHeaderSlotY) / 2 // 220
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
        pointerY: sectionBottomSlotY + 1, // 205, closer to 204 than 236
        containerTop: 0,
        scrollTop: 0,
        sidebarRepoHeaderIds: ['a', 'b'],
        rects: gapRects.map((rect) => ({ ...rect })),
        draggedRepoId: 'a',
        draggedSectionHeight: 28
      })

      // With only two headers, dropIndex 1 is 'a's own post-removal slot: no-op.
      expect(preview?.dropIndex).toBe(1)
      expect(Object.fromEntries(preview!.previewOffsetsByRepoId)).toEqual({})
    })

    it('snaps to the next header top when the pointer is nearer to it', () => {
      const preview = computeProjectHeaderDropPreview({
        pointerY: nextHeaderSlotY - 1, // 235, closer to 236 than 204
        containerTop: 0,
        scrollTop: 0,
        sidebarRepoHeaderIds: ['a', 'b'],
        rects: gapRects.map((rect) => ({ ...rect })),
        draggedRepoId: 'a',
        draggedSectionHeight: 28
      })

      expect(preview?.dropIndex).toBe(1)
      expect(Object.fromEntries(preview!.previewOffsetsByRepoId)).toEqual({})
    })

    it('breaks the midpoint tie toward the next header boundary', () => {
      const preview = computeProjectHeaderDropPreview({
        pointerY: midpointY, // 220, equidistant → next header wins
        containerTop: 0,
        scrollTop: 0,
        sidebarRepoHeaderIds: ['a', 'b'],
        rects: gapRects.map((rect) => ({ ...rect })),
        draggedRepoId: 'a',
        draggedSectionHeight: 28
      })

      expect(preview?.dropIndex).toBe(1)
      expect(Object.fromEntries(preview!.previewOffsetsByRepoId)).toEqual({})
    })
  })

  describe('content bound for the last section', () => {
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
        contentBottom,
        draggedRepoId: 'a',
        draggedSectionHeight: 28
      })

    it('rejects a drop below the measured content when the estimate overshoots', () => {
      // Estimate says the section ends at 380, but the list actually renders to
      // 340; a pointer at 360 is below real content → no fabricated final slot.
      expect(lastPreview(360, 340)).toBeNull()
    })

    it('rejects an edge-zone final drop below measured content when the estimate overshoots', () => {
      // 389 crosses the estimated final boundary (380 + 8px padding) while still
      // sitting below the measured list end, so the content bound must win.
      expect(lastPreview(389, 350)).toBeNull()
    })

    it('still snaps within the measured content when the estimate overshoots', () => {
      // 335 is inside the real last section (ends at 340) → drop after 'c'.
      // 'a' (index 0) moves to the end; 'b' and 'c' each shift up one section.
      const preview = lastPreview(335, 340)

      expect(preview?.dropIndex).toBe(3)
      expect(Object.fromEntries(preview!.previewOffsetsByRepoId)).toEqual({ b: -28, c: -28 })
    })

    it('snaps within the measured content when actual content undershoots the estimate', () => {
      // Real content taller than the estimate (420 > 380): a 360 drop is well
      // inside the section → still snaps to the final slot.
      const preview = lastPreview(360, 420)

      expect(preview?.dropIndex).toBe(3)
      expect(Object.fromEntries(preview!.previewOffsetsByRepoId)).toEqual({ b: -28, c: -28 })
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
