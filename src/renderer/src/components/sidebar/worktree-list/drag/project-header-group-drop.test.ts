import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  canRepoStartHeaderDrag,
  computeCombinedProjectHeaderDropTarget,
  getJoinableGroupIdsForRepo
} from './project-header-group-drop'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

function makeGroup(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
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
    executionHostId: 'local',
    ...overrides
  }
}

describe('getJoinableGroupIdsForRepo & canRepoStartHeaderDrag', () => {
  it('allows dragging a lone ungrouped repo only when a same-catalog group exists', () => {
    const localRepo = makeRepo('r1', { executionHostId: 'local' })
    const remoteOnlyGroups = [makeGroup('remote-g', { executionHostId: 'runtime:env-1' })]
    const localGroups = [makeGroup('local-g', { executionHostId: 'local' })]

    expect(
      canRepoStartHeaderDrag({
        repo: localRepo,
        allowSlotReorder: true,
        bucketItemCount: 1,
        joinableGroupIds: getJoinableGroupIdsForRepo(localRepo, remoteOnlyGroups)
      })
    ).toBe(false)

    expect(
      canRepoStartHeaderDrag({
        repo: localRepo,
        allowSlotReorder: false,
        bucketItemCount: 1,
        joinableGroupIds: getJoinableGroupIdsForRepo(localRepo, localGroups)
      })
    ).toBe(true)
  })

  it('allows dragging a lone grouped repo out of its group in both manual and recent order', () => {
    const groupedRepo = makeRepo('r1', { projectGroupId: 'g1' })
    const groups = [makeGroup('g1')]

    expect(
      canRepoStartHeaderDrag({
        repo: groupedRepo,
        allowSlotReorder: true,
        bucketItemCount: 1,
        joinableGroupIds: getJoinableGroupIdsForRepo(groupedRepo, groups)
      })
    ).toBe(true)

    expect(
      canRepoStartHeaderDrag({
        repo: groupedRepo,
        allowSlotReorder: false,
        bucketItemCount: 1,
        joinableGroupIds: getJoinableGroupIdsForRepo(groupedRepo, groups)
      })
    ).toBe(true)
  })
})

describe('computeCombinedProjectHeaderDropTarget', () => {
  it('targets a joinable group header when pointer hits its center band even in recent order', () => {
    const target = computeCombinedProjectHeaderDropTarget({
      pointerY: 14,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: null,
      allowSlotReorder: false,
      joinableGroupIds: new Set(['g1']),
      groupHeaderRects: [
        { groupId: 'g1', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28, sectionBottom: 28 }
      ],
      repoHeaderRects: [
        { repoId: 'r1', bucketKey: 'ungrouped', headerIndex: 0, top: 32, bottom: 60 }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([['ungrouped', ['r1']]])
    })

    expect(target).toEqual({ kind: 'group-header', groupId: 'g1' })
  })

  it('ignores a group header owned by another host', () => {
    const target = computeCombinedProjectHeaderDropTarget({
      pointerY: 14,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: null,
      allowSlotReorder: false,
      joinableGroupIds: new Set(),
      groupHeaderRects: [
        { groupId: 'remote-g', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28 }
      ],
      repoHeaderRects: [],
      sidebarRepoHeaderIdsByBucket: new Map()
    })

    expect(target).toBeNull()
  })

  it('targets the innermost nested subgroup slot when dragging between subgroup projects', () => {
    const target = computeCombinedProjectHeaderDropTarget({
      pointerY: 84,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: null,
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-parent', 'g-sub']),
      groupHeaderRects: [
        {
          groupId: 'g-parent',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 140
        },
        {
          groupId: 'g-sub',
          bucketKey: 'parent:g-parent',
          headerIndex: 0,
          top: 28,
          bottom: 56,
          sectionBottom: 140
        }
      ],
      repoHeaderRects: [
        { repoId: 's1', bucketKey: 'group:g-sub', headerIndex: 0, top: 56, bottom: 84 },
        { repoId: 's2', bucketKey: 'group:g-sub', headerIndex: 1, top: 84, bottom: 112 }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([['group:g-sub', ['s1', 's2']]])
    })

    expect(target).toMatchObject({
      kind: 'slot',
      targetBucketKey: 'group:g-sub',
      dropIndex: 1
    })
  })

  it('provides an ungrouped slot below the last group when all projects are currently grouped', () => {
    const target = computeCombinedProjectHeaderDropTarget({
      pointerY: 95,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g1',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g1']),
      groupHeaderRects: [
        { groupId: 'g1', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28, sectionBottom: 80 }
      ],
      repoHeaderRects: [
        {
          repoId: 'r1',
          bucketKey: 'group:g1',
          headerIndex: 0,
          top: 28,
          bottom: 56,
          sectionBottom: 80
        }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([['group:g1', ['r1']]]),
      contentBottom: 120
    })

    expect(target).toEqual({
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 0,
      dropIndicatorY: 84
    })
  })

  it('returns null instead of leaking to parent group when hovering own subgroup header', () => {
    const target = computeCombinedProjectHeaderDropTarget({
      pointerY: 70,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g-sub',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-parent', 'g-sub']),
      groupHeaderRects: [
        {
          groupId: 'g-parent',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 140
        },
        {
          groupId: 'g-sub',
          bucketKey: 'parent:g-parent',
          headerIndex: 0,
          top: 56,
          bottom: 84,
          sectionBottom: 140
        }
      ],
      repoHeaderRects: [
        { repoId: 'p1', bucketKey: 'group:g-parent', headerIndex: 0, top: 28, bottom: 56 },
        { repoId: 's1', bucketKey: 'group:g-sub', headerIndex: 0, top: 84, bottom: 112 }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g-parent', ['p1']],
        ['group:g-sub', ['s1']]
      ])
    })

    expect(target).toBeNull()
  })

  it('targets subgroup slot 0 rather than parent group when aiming at expanded subgroup bottom gutter', () => {
    const target = computeCombinedProjectHeaderDropTarget({
      pointerY: 82,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: null,
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-parent', 'g-sub']),
      groupHeaderRects: [
        {
          groupId: 'g-parent',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 140
        },
        {
          groupId: 'g-sub',
          bucketKey: 'parent:g-parent',
          headerIndex: 0,
          top: 56,
          bottom: 84,
          sectionBottom: 140
        }
      ],
      repoHeaderRects: [
        { repoId: 'p1', bucketKey: 'group:g-parent', headerIndex: 0, top: 28, bottom: 56 },
        { repoId: 's1', bucketKey: 'group:g-sub', headerIndex: 0, top: 84, bottom: 112 }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g-parent', ['p1']],
        ['group:g-sub', ['s1']]
      ])
    })

    expect(target).toMatchObject({
      kind: 'slot',
      targetBucketKey: 'group:g-sub',
      dropIndex: 0
    })
  })

  it('scopes empty ungrouped drop zone to the dragged host section and joinable groups', () => {
    const hostHeaderRects = [
      { hostId: 'local' as const, top: 0, bottom: 32 },
      { hostId: 'runtime:env-1' as const, top: 160, bottom: 192 }
    ]
    const groupHeaderRects = [
      {
        groupId: 'local-g',
        bucketKey: 'root',
        headerIndex: 0,
        top: 32,
        bottom: 60,
        sectionBottom: 112
      },
      {
        groupId: 'remote-g',
        bucketKey: 'root',
        headerIndex: 1,
        top: 192,
        bottom: 220,
        sectionBottom: 280
      }
    ]

    const insideLocalTail = computeCombinedProjectHeaderDropTarget({
      pointerY: 125,
      containerTop: 0,
      scrollTop: 0,
      dragHostId: 'local',
      currentGroupId: 'local-g',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['local-g']),
      hostHeaderRects,
      groupHeaderRects,
      repoHeaderRects: [],
      sidebarRepoHeaderIdsByBucket: new Map([['group:local-g', ['r1']]]),
      contentBottom: 320
    })
    expect(insideLocalTail).toEqual({
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 0,
      dropIndicatorY: 116
    })

    const insideRemoteSection = computeCombinedProjectHeaderDropTarget({
      pointerY: 170,
      containerTop: 0,
      scrollTop: 0,
      dragHostId: 'local',
      currentGroupId: 'local-g',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['local-g']),
      hostHeaderRects,
      groupHeaderRects,
      repoHeaderRects: [],
      sidebarRepoHeaderIdsByBucket: new Map([['group:local-g', ['r1']]]),
      contentBottom: 320
    })
    expect(insideRemoteSection).toBeNull()
  })
})

describe('commitProjectHeaderDragDrop cross-group moves', () => {
  it('moves a project into a group header when dropped on a group-header target', async () => {
    const r1 = makeRepo('r1')
    const onMoveToGroupHeader = vi.fn()

    await commitProjectHeaderDragDrop({
      session: {
        repo: r1,
        bucketKey: 'ungrouped',
        sidebarRepoHeaderIds: ['r1']
      },
      dropTarget: { kind: 'group-header', groupId: 'g1' },
      sidebarRepoHeaderIdsByBucket: new Map([['ungrouped', ['r1']]]),
      orderedRepoIds: ['r1'],
      repoById: new Map([['r1', r1]]),
      liveRepos: [r1],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: vi.fn(),
      onMoveToGroupHeader
    })

    expect(onMoveToGroupHeader).toHaveBeenCalledWith(r1, 'g1')
  })

  it('computes midpoint order when inserting a project into another open group slot', async () => {
    const dragged = makeRepo('r-drag')
    const s1 = makeRepo('s1', { projectGroupId: 'g2', projectGroupOrder: 0 })
    const s2 = makeRepo('s2', { projectGroupId: 'g2', projectGroupOrder: 10 })
    const onCommitProjectGroupOrder = vi.fn()

    await commitProjectHeaderDragDrop({
      session: {
        repo: dragged,
        bucketKey: 'ungrouped',
        sidebarRepoHeaderIds: ['r-drag']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:g2',
        dropIndex: 1,
        dropIndicatorY: 70
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['r-drag']],
        ['group:g2', ['s1', 's2']]
      ]),
      orderedRepoIds: ['r-drag', 's1', 's2'],
      repoById: new Map([
        ['r-drag', dragged],
        ['s1', s1],
        ['s2', s2]
      ]),
      liveRepos: [dragged, s1, s2],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(dragged, 'g2', 5)
  })

  it('moves a lone grouped project back to ungrouped root when dropped on the empty ungrouped slot', async () => {
    const r1 = makeRepo('r1', { projectGroupId: 'g1', projectGroupOrder: 0 })
    const onCommitProjectGroupOrder = vi.fn()

    await commitProjectHeaderDragDrop({
      session: {
        repo: r1,
        bucketKey: 'group:g1',
        sidebarRepoHeaderIds: ['r1']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'ungrouped',
        dropIndex: 0,
        dropIndicatorY: 84
      },
      sidebarRepoHeaderIdsByBucket: new Map([['group:g1', ['r1']]]),
      orderedRepoIds: ['r1'],
      repoById: new Map([['r1', r1]]),
      liveRepos: [r1],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(r1, null, 0)
  })

  it('mutates the localized host registration (groupRepo) rather than the ordering anchor twin on group moves', async () => {
    const localAnchor = makeRepo('twin', { executionHostId: 'local' })
    const remoteTwin = makeRepo('twin', { executionHostId: 'runtime:env-1' })
    const onMoveToGroupHeader = vi.fn()

    await commitProjectHeaderDragDrop({
      session: {
        repo: localAnchor,
        groupRepo: remoteTwin,
        bucketKey: 'ungrouped',
        sidebarRepoHeaderIds: ['twin']
      },
      dropTarget: { kind: 'group-header', groupId: 'remote-g' },
      sidebarRepoHeaderIdsByBucket: new Map([['ungrouped', ['twin']]]),
      orderedRepoIds: ['twin'],
      repoById: new Map([['twin', localAnchor]]),
      liveRepos: [localAnchor, remoteTwin],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: vi.fn(),
      onMoveToGroupHeader
    })

    expect(onMoveToGroupHeader).toHaveBeenCalledWith(remoteTwin, 'remote-g')
  })

  it('allows dragging a project from a subgroup into an expanded parent group with zero direct projects (both above and right below the subgroup)', () => {
    const groupHeaderRects = [
      {
        groupId: 'g-root',
        bucketKey: 'root',
        headerIndex: 0,
        top: 0,
        bottom: 28,
        sectionBottom: 164
      },
      {
        groupId: 'g-sub',
        bucketKey: 'parent:g-root',
        headerIndex: 0,
        top: 34,
        bottom: 62,
        sectionBottom: 164
      }
    ]
    const repoHeaderRects = [
      {
        repoId: 'unity',
        bucketKey: 'group:g-sub',
        headerIndex: 0,
        top: 72,
        bottom: 100,
        sectionBottom: 164
      }
    ]
    const buckets = new Map<string, readonly string[]>([['group:g-sub', ['unity']]])

    // 1. Gap between parent header (0..28) and subgroup header (34..62)
    const aboveSubgroup = computeCombinedProjectHeaderDropTarget({
      pointerY: 31,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g-sub',
      currentParentGroupId: 'g-root',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-root', 'g-sub']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: buckets,
      contentBottom: 164
    })
    expect(aboveSubgroup).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g-root',
      dropIndex: 0,
      dropIndicatorY: 32
    })

    // 2. Subgroup exit band right below the subgroup (y = 172, within 20px of 164) -> parent group!
    const belowSubgroupExitBand = computeCombinedProjectHeaderDropTarget({
      pointerY: 172,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g-sub',
      currentParentGroupId: 'g-root',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-root', 'g-sub']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: buckets,
      contentBottom: 164
    })
    expect(belowSubgroupExitBand).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g-root',
      dropIndex: 0,
      dropIndicatorY: 166
    })

    // 3. Dragging further down past the parent exit band (y = 192) -> ungrouped root!
    const furtherDownRoot = computeCombinedProjectHeaderDropTarget({
      pointerY: 192,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g-sub',
      currentParentGroupId: 'g-root',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-root', 'g-sub']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: buckets,
      contentBottom: 164
    })
    expect(furtherDownRoot).toEqual({
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 0,
      dropIndicatorY: 168
    })

    // 4. In recent order (allowSlotReorder: false), membership exits to parent and ungrouped stay active, while same-bucket stays inert
    expect(
      computeCombinedProjectHeaderDropTarget({
        pointerY: 172,
        containerTop: 0,
        scrollTop: 0,
        currentGroupId: 'g-sub',
        currentParentGroupId: 'g-root',
        allowSlotReorder: false,
        joinableGroupIds: new Set(['g-root', 'g-sub']),
        groupHeaderRects,
        repoHeaderRects,
        sidebarRepoHeaderIdsByBucket: buckets,
        contentBottom: 164
      })
    ).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g-root',
      dropIndex: 0,
      dropIndicatorY: 166
    })
    expect(
      computeCombinedProjectHeaderDropTarget({
        pointerY: 192,
        containerTop: 0,
        scrollTop: 0,
        currentGroupId: 'g-sub',
        currentParentGroupId: 'g-root',
        allowSlotReorder: false,
        joinableGroupIds: new Set(['g-root', 'g-sub']),
        groupHeaderRects,
        repoHeaderRects,
        sidebarRepoHeaderIdsByBucket: buckets,
        contentBottom: 164
      })
    ).toEqual({
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 0,
      dropIndicatorY: 168
    })
    expect(
      computeCombinedProjectHeaderDropTarget({
        pointerY: 85,
        containerTop: 0,
        scrollTop: 0,
        currentGroupId: 'g-sub',
        currentParentGroupId: 'g-root',
        allowSlotReorder: false,
        joinableGroupIds: new Set(['g-root', 'g-sub']),
        groupHeaderRects,
        repoHeaderRects,
        sidebarRepoHeaderIdsByBucket: buckets,
        contentBottom: 164
      })
    ).toBeNull()
  })
})
