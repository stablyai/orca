import { describe, expect, it, vi } from 'vitest'

import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { RenderRow } from '../listing/render-row'
import {
  getProjectGroupHeaderSectionEndIndexByGroupId,
  getRepoHeaderSectionEndIndexByRepoId
} from '../viewport/worktree-header-section-boundaries'
import { computeCombinedProjectGroupHeaderDropTarget } from './project-group-header-reparent-drop'
import { getProjectGroupMutationsForDrop } from './project-group-header-drag-commit'
import { computeAppendedProjectGroupTabOrder } from './project-group-child-drop-commit'
import { computeCombinedProjectHeaderDropTarget } from './project-header-group-drop'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'

function makeGroup(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    isPinned: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#111111',
    addedAt: 1,
    ...overrides
  }
}

describe('interleaved subgroup and project boundaries and drag-and-drop inside a group', () => {
  it('stops repo and subgroup section boundaries at the immediately following interleaved header', () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const sub1 = makeGroup('sub1', { parentGroupId: 'g1', tabOrder: 1 })
    const sub2 = makeGroup('sub2', { parentGroupId: 'g1', tabOrder: 3 })
    const p1 = makeRepo('p1', { projectGroupId: 'g1', projectGroupOrder: 0 })
    const pSub = makeRepo('p-sub', { projectGroupId: 'sub1', projectGroupOrder: 0 })
    const p2 = makeRepo('p2', { projectGroupId: 'g1', projectGroupOrder: 2 })

    const rows: RenderRow[] = [
      {
        type: 'header',
        key: 'project-group:g1',
        label: 'g1',
        count: 3,
        icon: { kind: 'project' },
        projectGroup: parent,
        projectGroupDepth: 0
      },
      {
        type: 'header',
        key: 'repo:p1',
        label: 'p1',
        count: 1,
        icon: { kind: 'project' },
        repo: p1,
        projectGroupDepth: 1
      },
      {
        type: 'header',
        key: 'project-group:sub1',
        label: 'sub1',
        count: 1,
        icon: { kind: 'project' },
        projectGroup: sub1,
        projectGroupDepth: 1
      },
      {
        type: 'header',
        key: 'repo:p-sub',
        label: 'p-sub',
        count: 0,
        icon: { kind: 'project' },
        repo: pSub,
        projectGroupDepth: 2
      },
      {
        type: 'header',
        key: 'repo:p2',
        label: 'p2',
        count: 0,
        icon: { kind: 'project' },
        repo: p2,
        projectGroupDepth: 1
      },
      {
        type: 'header',
        key: 'project-group:sub2',
        label: 'sub2',
        count: 0,
        icon: { kind: 'project' },
        projectGroup: sub2,
        projectGroupDepth: 1
      }
    ]

    const repoEnds = getRepoHeaderSectionEndIndexByRepoId({
      rows,
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g1', ['p1', 'p2']],
        ['group:sub1', ['p-sub']]
      ]),
      repoHeaderBucketByRepoId: new Map([
        ['p1', 'group:g1'],
        ['p2', 'group:g1'],
        ['p-sub', 'group:sub1']
      ])
    })
    // p1 (index 1) must stop right at sub1 (index 2), NOT jump across sub1 to p2 (index 4)!
    expect(repoEnds.get('p1')).toBe(2)
    expect(repoEnds.get('p2')).toBe(5)

    const groupEnds = getProjectGroupHeaderSectionEndIndexByGroupId({
      rows,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['g1']],
        ['parent:g1', ['sub1', 'sub2']]
      ]),
      projectGroupHeaderBucketByGroupId: new Map([
        ['g1', 'root'],
        ['sub1', 'parent:g1'],
        ['sub2', 'parent:g1']
      ])
    })
    // sub1 (index 2, containing p-sub at index 3) must stop right at p2 (index 4), NOT jump across p2 to sub2 (index 5)!
    expect(groupEnds.get('sub1')).toBe(4)
    expect(groupEnds.get('g1')).toBe(6)
  })

  it('positions a lone subgroup above or between projects inside its parent group in manual order', () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const sub1 = makeGroup('sub1', { parentGroupId: 'g1', tabOrder: 2 })
    const p1 = makeRepo('p1', { projectGroupId: 'g1', projectGroupOrder: 0 })
    const p2 = makeRepo('p2', { projectGroupId: 'g1', projectGroupOrder: 1 })
    const projectGroupById = new Map([
      ['g1', parent],
      ['sub1', sub1]
    ])
    const repoById = new Map([
      ['p1', p1],
      ['p2', p2]
    ])
    const sidebarGroupChildItemIdsByGroupId = new Map([
      ['g1', ['repo:p1', 'repo:p2', 'group:sub1'] as const]
    ])
    const groupHeaderRects = [
      { groupId: 'g1', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28, sectionBottom: 192 },
      {
        groupId: 'sub1',
        bucketKey: 'parent:g1',
        headerIndex: 0,
        top: 164,
        bottom: 192,
        sectionBottom: 192
      }
    ]
    const repoHeaderRects = [
      {
        repoId: 'p1',
        bucketKey: 'group:g1',
        headerIndex: 0,
        top: 32,
        bottom: 60,
        sectionBottom: 96
      },
      {
        repoId: 'p2',
        bucketKey: 'group:g1',
        headerIndex: 1,
        top: 100,
        bottom: 128,
        sectionBottom: 160
      }
    ]

    // Drag sub1 above p1 (pointerY = 38, top half of p1)
    const aboveP1 = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 38,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: sub1,
      projectGroupById,
      reparentableGroupIds: new Set(['g1']),
      groupHeaderRects,
      repoHeaderRects,
      allowMixedProjectReorder: true,
      sidebarGroupChildItemIdsByGroupId,
      repoById,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['g1']],
        ['parent:g1', ['sub1']]
      ]),
      contentBottom: 192
    })
    expect(aboveP1).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:g1',
      dropIndex: 0,
      dropIndicatorY: 28
    })

    const aboveMutations = getProjectGroupMutationsForDrop({
      draggedGroup: sub1,
      sourceBucketKey: 'parent:g1',
      dropTarget: aboveP1!,
      projectGroupById,
      allowMixedProjectReorder: true,
      sidebarGroupChildItemIdsByGroupId,
      repoById,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['g1']],
        ['parent:g1', ['sub1']]
      ])
    })
    expect(aboveMutations).toEqual([{ groupId: 'sub1', updates: { tabOrder: -1 } }])

    // Drag sub1 between p1 (0) and p2 (1) (pointerY = 90, bottom of p1's cards)
    const betweenProjects = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 90,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: sub1,
      projectGroupById,
      reparentableGroupIds: new Set(['g1']),
      groupHeaderRects,
      repoHeaderRects,
      allowMixedProjectReorder: true,
      sidebarGroupChildItemIdsByGroupId,
      repoById,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['g1']],
        ['parent:g1', ['sub1']]
      ]),
      contentBottom: 192
    })
    expect(betweenProjects).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:g1',
      dropIndex: 1,
      dropIndicatorY: 96
    })

    const betweenMutations = getProjectGroupMutationsForDrop({
      draggedGroup: sub1,
      sourceBucketKey: 'parent:g1',
      dropTarget: betweenProjects!,
      projectGroupById,
      allowMixedProjectReorder: true,
      sidebarGroupChildItemIdsByGroupId,
      repoById,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['g1']],
        ['parent:g1', ['sub1']]
      ])
    })
    expect(betweenMutations).toEqual([{ groupId: 'sub1', updates: { tabOrder: 0.5 } }])
  })

  it('reorders a subgroup after an expanded or collapsed sibling subgroup without nesting into it or kicking out to root', () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const sub1 = makeGroup('sub1', { parentGroupId: 'g1', tabOrder: 0 })
    const sub2 = makeGroup('sub2', { parentGroupId: 'g1', tabOrder: 1 })
    const projectGroupById = new Map([
      ['g1', parent],
      ['sub1', sub1],
      ['sub2', sub2]
    ])
    const sidebarProjectGroupHeaderIdsByBucket = new Map([
      ['root', ['g1']],
      ['parent:g1', ['sub1', 'sub2']]
    ])

    // Case 1: sub2 is expanded (100..128, sectionBottom: 200). Pointer in sub2's body (160) must reorder AFTER sub2 in parent:g1, NOT nest into parent:sub2!
    const afterExpandedSub2 = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 160,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: sub1,
      projectGroupById,
      reparentableGroupIds: new Set(['g1', 'sub2']),
      groupHeaderRects: [
        {
          groupId: 'g1',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 200
        },
        {
          groupId: 'sub1',
          bucketKey: 'parent:g1',
          headerIndex: 0,
          top: 32,
          bottom: 60,
          sectionBottom: 96
        },
        {
          groupId: 'sub2',
          bucketKey: 'parent:g1',
          headerIndex: 1,
          top: 100,
          bottom: 128,
          sectionBottom: 200
        }
      ],
      sidebarProjectGroupHeaderIdsByBucket,
      contentBottom: 200
    })
    expect(afterExpandedSub2).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:g1',
      dropIndex: 2,
      dropIndicatorY: 204
    })

    // Hovering sub2's header center (114) STILL highlights sub2 to nest sub1 inside sub2
    const ontoSub2Header = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 114,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: sub1,
      projectGroupById,
      reparentableGroupIds: new Set(['g1', 'sub2']),
      groupHeaderRects: [
        {
          groupId: 'g1',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 200
        },
        {
          groupId: 'sub1',
          bucketKey: 'parent:g1',
          headerIndex: 0,
          top: 32,
          bottom: 60,
          sectionBottom: 96
        },
        {
          groupId: 'sub2',
          bucketKey: 'parent:g1',
          headerIndex: 1,
          top: 100,
          bottom: 128,
          sectionBottom: 200
        }
      ],
      sidebarProjectGroupHeaderIdsByBucket,
      contentBottom: 200
    })
    expect(ontoSub2Header).toEqual({ kind: 'group-header', groupId: 'sub2' })

    // Case 2: sub2 is collapsed at the end of g1 (top: 100, bottom: 128, g1.sectionBottom: 128). Pointer 6px below sub2 (134) stays in parent:g1 after sub2!
    const afterCollapsedTrailingSub2 = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 134,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: sub1,
      projectGroupById,
      reparentableGroupIds: new Set(['g1', 'sub2']),
      groupHeaderRects: [
        {
          groupId: 'g1',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 128
        },
        {
          groupId: 'sub1',
          bucketKey: 'parent:g1',
          headerIndex: 0,
          top: 32,
          bottom: 60,
          sectionBottom: 96
        },
        {
          groupId: 'sub2',
          bucketKey: 'parent:g1',
          headerIndex: 1,
          top: 100,
          bottom: 128,
          sectionBottom: 128
        }
      ],
      sidebarProjectGroupHeaderIdsByBucket,
      contentBottom: 128
    })
    expect(afterCollapsedTrailingSub2).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:g1',
      dropIndex: 2,
      dropIndicatorY: 132
    })
  })

  it('positions a lone project above, between, or below subgroups inside its parent group while preserving subgroup header drop', async () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const sub1 = makeGroup('sub1', { parentGroupId: 'g1', tabOrder: 0 })
    const sub2 = makeGroup('sub2', { parentGroupId: 'g1', tabOrder: 2 })
    const p1 = makeRepo('p1', { projectGroupId: 'g1', projectGroupOrder: 5 })
    const projectGroupById = new Map([
      ['g1', parent],
      ['sub1', sub1],
      ['sub2', sub2]
    ])
    const repoById = new Map([['p1', p1]])
    const sidebarGroupChildItemIdsByGroupId = new Map([
      ['g1', ['group:sub1', 'group:sub2', 'repo:p1'] as const]
    ])
    const groupHeaderRects = [
      { groupId: 'g1', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28, sectionBottom: 192 },
      {
        groupId: 'sub1',
        bucketKey: 'parent:g1',
        headerIndex: 0,
        top: 32,
        bottom: 60,
        sectionBottom: 96
      },
      {
        groupId: 'sub2',
        bucketKey: 'parent:g1',
        headerIndex: 1,
        top: 100,
        bottom: 128,
        sectionBottom: 160
      }
    ]
    const repoHeaderRects = [
      {
        repoId: 'p1',
        bucketKey: 'group:g1',
        headerIndex: 0,
        top: 164,
        bottom: 192,
        sectionBottom: 192
      }
    ]

    // Between sub1 (sectionBottom 96) and sub2 (top 100) at pointerY = 98
    const betweenSubs = computeCombinedProjectHeaderDropTarget({
      pointerY: 98,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g1',
      draggedRepoPinned: false,
      repoById,
      projectGroupById,
      sidebarGroupChildItemIdsByGroupId,
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g1', 'sub1', 'sub2']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: new Map([['group:g1', ['p1']]]),
      contentBottom: 192
    })
    expect(betweenSubs).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g1',
      dropIndex: 1,
      dropIndicatorY: 96
    })

    const onCommitProjectGroupOrder = vi.fn()
    await commitProjectHeaderDragDrop({
      session: {
        repo: p1,
        groupRepo: p1,
        bucketKey: 'group:g1',
        sidebarRepoHeaderIds: ['p1']
      },
      dropTarget: betweenSubs!,
      sidebarRepoHeaderIdsByBucket: new Map([['group:g1', ['p1']]]),
      sidebarGroupChildItemIdsByGroupId,
      projectGroupById,
      orderedRepoIds: ['p1'],
      repoById,
      liveRepos: [p1],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })
    // Between sub1 (tabOrder 0) and sub2 (tabOrder 2) -> midpoint 1!
    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(p1, 'g1', 1)
  })

  it('exits a project from a trailing subgroup into a mixed parent group right after that subgroup', async () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const sub1 = makeGroup('sub1', { parentGroupId: 'g1', tabOrder: 2 })
    const pParent = makeRepo('p-parent', { projectGroupId: 'g1', projectGroupOrder: 0 })
    const pSub = makeRepo('p-sub', { projectGroupId: 'sub1', projectGroupOrder: 0 })
    const projectGroupById = new Map([
      ['g1', parent],
      ['sub1', sub1]
    ])
    const repoById = new Map([
      ['p-parent', pParent],
      ['p-sub', pSub]
    ])
    const sidebarGroupChildItemIdsByGroupId = new Map([
      ['g1', ['repo:p-parent', 'group:sub1'] as const],
      ['sub1', ['repo:p-sub'] as const]
    ])

    const exitToParent = computeCombinedProjectHeaderDropTarget({
      pointerY: 168,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'sub1',
      currentParentGroupId: 'g1',
      draggedRepoPinned: false,
      repoById,
      projectGroupById,
      sidebarGroupChildItemIdsByGroupId,
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g1', 'sub1']),
      groupHeaderRects: [
        {
          groupId: 'g1',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 160
        },
        {
          groupId: 'sub1',
          bucketKey: 'parent:g1',
          headerIndex: 0,
          top: 96,
          bottom: 124,
          sectionBottom: 160
        }
      ],
      repoHeaderRects: [
        {
          repoId: 'p-parent',
          bucketKey: 'group:g1',
          headerIndex: 0,
          top: 32,
          bottom: 60,
          sectionBottom: 92
        },
        {
          repoId: 'p-sub',
          bucketKey: 'group:sub1',
          headerIndex: 0,
          top: 128,
          bottom: 160,
          sectionBottom: 160
        }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g1', ['p-parent']],
        ['group:sub1', ['p-sub']]
      ]),
      contentBottom: 160
    })

    expect(exitToParent).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g1',
      dropIndex: 2,
      dropIndicatorY: 162
    })

    const onCommitProjectGroupOrder = vi.fn()
    await commitProjectHeaderDragDrop({
      session: {
        repo: pSub,
        groupRepo: pSub,
        bucketKey: 'group:sub1',
        sidebarRepoHeaderIds: ['p-sub']
      },
      dropTarget: exitToParent!,
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g1', ['p-parent']],
        ['group:sub1', ['p-sub']]
      ]),
      sidebarGroupChildItemIdsByGroupId,
      projectGroupById,
      orderedRepoIds: ['p-parent', 'p-sub'],
      repoById,
      liveRepos: [pParent, pSub],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })
    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(pSub, 'g1', 3)
  })

  it('computes appended subgroup tabOrder past both sibling subgroups and sibling projects in a parent group', () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const sub1 = makeGroup('sub1', { parentGroupId: 'g1', tabOrder: 1 })
    const moving = makeGroup('g2', { tabOrder: 1 })
    const p1 = makeRepo('p1', { projectGroupId: 'g1', projectGroupOrder: 4 })

    const tabOrder = computeAppendedProjectGroupTabOrder({
      groupId: 'g2',
      parentGroupId: 'g1',
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['g1', 'g2']],
        ['parent:g1', ['sub1']]
      ]),
      sidebarGroupChildItemIdsByGroupId: new Map([['g1', ['group:sub1', 'repo:p1'] as const]]),
      projectGroupById: new Map([
        ['g1', parent],
        ['sub1', sub1],
        ['g2', moving]
      ]),
      repoById: new Map([['p1', p1]]),
      orderedRepoIds: ['p1']
    })

    expect(tabOrder).toBe(5)
  })

  it('aborts target sibling renumbering when a cross-bucket project move is rejected', async () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const sub1 = makeGroup('sub1', { parentGroupId: 'g1', tabOrder: 0 })
    const pExisting = makeRepo('p-existing', { projectGroupId: 'g1', projectGroupOrder: 0 })
    const pIncoming = makeRepo('p-incoming', { projectGroupId: null })
    const onCommitProjectGroupOrder = vi.fn().mockResolvedValue(false)
    const onCommitProjectGroupUpdate = vi.fn().mockResolvedValue(true)

    await commitProjectHeaderDragDrop({
      session: {
        repo: pIncoming,
        groupRepo: pIncoming,
        bucketKey: 'ungrouped',
        sidebarRepoHeaderIds: ['p-incoming']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:g1',
        dropIndex: 1,
        dropIndicatorY: 60
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['p-incoming']],
        ['group:g1', ['p-existing']]
      ]),
      sidebarGroupChildItemIdsByGroupId: new Map([
        ['g1', ['group:sub1', 'repo:p-existing'] as const]
      ]),
      projectGroupById: new Map([
        ['g1', parent],
        ['sub1', sub1]
      ]),
      orderedRepoIds: ['p-incoming', 'p-existing'],
      repoById: new Map([
        ['p-incoming', pIncoming],
        ['p-existing', pExisting]
      ]),
      liveRepos: [pIncoming, pExisting],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onCommitProjectGroupUpdate,
      onMoveToGroupHeader: vi.fn()
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledTimes(1)
    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(pIncoming, 'g1', 1)
    expect(onCommitProjectGroupUpdate).not.toHaveBeenCalled()
  })

  it('clears rootProjectOrder when nesting a ranked root group into a mixed parent group', () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const sub1 = makeGroup('sub1', { parentGroupId: 'g1', tabOrder: 0 })
    const p1 = makeRepo('p1', { projectGroupId: 'g1', projectGroupOrder: 0 })
    const rankedRoot = makeGroup('g-ranked', { tabOrder: 2, rootProjectOrder: 2000 })
    const projectGroupById = new Map([
      ['g1', parent],
      ['sub1', sub1],
      ['g-ranked', rankedRoot]
    ])
    const repoById = new Map([['p1', p1]])
    const sidebarGroupChildItemIdsByGroupId = new Map([['g1', ['group:sub1', 'repo:p1'] as const]])
    const sidebarProjectGroupHeaderIdsByBucket = new Map([
      ['root', ['g1', 'g-ranked']],
      ['parent:g1', ['sub1']]
    ])

    // Single-rank append onto parent group header
    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: rankedRoot,
        sourceBucketKey: 'root',
        dropTarget: { kind: 'group-header', groupId: 'g1' },
        projectGroupById,
        allowMixedProjectReorder: true,
        sidebarGroupChildItemIdsByGroupId,
        repoById,
        orderedRepoIds: ['p1'],
        sidebarProjectGroupHeaderIdsByBucket
      })
    ).toEqual([
      {
        groupId: 'g-ranked',
        updates: { parentGroupId: 'g1', tabOrder: 1, rootProjectOrder: null }
      }
    ])

    // Reindex path when dropping between colliding ranks (sub1: 0, p1: 0) at dropIndex 1
    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: rankedRoot,
        sourceBucketKey: 'root',
        dropTarget: {
          kind: 'slot',
          targetBucketKey: 'parent:g1',
          dropIndex: 1,
          dropIndicatorY: 60
        },
        projectGroupById,
        allowMixedProjectReorder: true,
        sidebarGroupChildItemIdsByGroupId,
        repoById,
        orderedRepoIds: ['p1'],
        sidebarProjectGroupHeaderIdsByBucket
      })
    ).toEqual([
      {
        groupId: 'g-ranked',
        updates: { parentGroupId: 'g1', tabOrder: 1, rootProjectOrder: null }
      },
      {
        kind: 'repo',
        repo: p1,
        projectGroupId: 'g1',
        order: 2
      }
    ])
  })

  it('sequentially awaits same-bucket mixed-child updates in commitProjectHeaderDragDrop and stops when an update returns false', async () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const subA = makeGroup('sub-a', { parentGroupId: 'g1', tabOrder: 0 })
    const subStay = makeGroup('sub-stay', { parentGroupId: 'g1', tabOrder: 0 })
    const pDrag = makeRepo('p-drag', { projectGroupId: 'g1', projectGroupOrder: 3 })
    const projectGroupById = new Map([
      ['g1', parent],
      ['sub-a', subA],
      ['sub-stay', subStay]
    ])
    const callLog: string[] = []
    const onCommitProjectGroupOrder = vi.fn().mockImplementation(async (repo: { id: string }) => {
      callLog.push(`repo:${repo.id}`)
      return false
    })
    const onCommitProjectGroupUpdate = vi.fn().mockImplementation(async (groupId: string) => {
      callLog.push(`group:${groupId}`)
      return true
    })

    await commitProjectHeaderDragDrop({
      session: {
        repo: pDrag,
        bucketKey: 'group:g1',
        sidebarRepoHeaderIds: ['p-drag']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:g1',
        dropIndex: 1,
        dropIndicatorY: 60
      },
      sidebarRepoHeaderIdsByBucket: new Map([['group:g1', ['p-drag']]]),
      sidebarGroupChildItemIdsByGroupId: new Map([
        ['g1', ['group:sub-a', 'group:sub-stay', 'repo:p-drag'] as const]
      ]),
      projectGroupById,
      orderedRepoIds: ['p-drag'],
      repoById: new Map([['p-drag', pDrag]]),
      liveRepos: [pDrag],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onCommitProjectGroupUpdate,
      onMoveToGroupHeader: vi.fn()
    })

    expect(callLog).toEqual(['repo:p-drag'])
    expect(onCommitProjectGroupUpdate).not.toHaveBeenCalled()
  })
})
