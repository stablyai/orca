import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { commitProjectGroupHeaderDragDrop } from './project-group-header-drag-commit'
import { computeCombinedProjectGroupHeaderDropTarget } from './project-group-header-reparent-drop'
import {
  canRepoStartHeaderDrag,
  computeCombinedProjectHeaderDropTarget
} from './project-header-group-drop'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'

function makeGroup(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    executionHostId: 'local',
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
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

describe('project header pin-tier drag scoping', () => {
  it('keeps an ungrouped repo inert when the only other ungrouped repo is in a different pin tier and no groups exist', () => {
    const pinnedRepo = makeRepo('p1', { isPinned: true })
    const unpinnedRepo = makeRepo('u1', { isPinned: false })
    const pinnedSet = new Set(['p1'])

    expect(
      canRepoStartHeaderDrag({
        repo: pinnedRepo,
        allowSlotReorder: true,
        bucketItemCount: 2,
        bucketHeaderIds: ['p1', 'u1'],
        pinnedRepoHeaderIds: pinnedSet,
        joinableGroupIds: new Set()
      })
    ).toBe(false)

    expect(
      canRepoStartHeaderDrag({
        repo: pinnedRepo,
        allowSlotReorder: true,
        bucketItemCount: 3,
        bucketHeaderIds: ['p1', 'p2', 'u1'],
        pinnedRepoHeaderIds: new Set(['p1', 'p2']),
        joinableGroupIds: new Set()
      })
    ).toBe(true)

    expect(
      canRepoStartHeaderDrag({
        repo: unpinnedRepo,
        allowSlotReorder: true,
        bucketItemCount: 3,
        bucketHeaderIds: ['p1', 'u1', 'u2'],
        pinnedRepoHeaderIds: pinnedSet,
        joinableGroupIds: new Set()
      })
    ).toBe(true)
  })

  it('isolates same-bucket project drag preview and commit to the dragged project pin tier', async () => {
    const p1 = makeRepo('p1', { projectGroupId: 'g1', projectGroupOrder: 0, isPinned: true })
    const p2 = makeRepo('p2', { projectGroupId: 'g1', projectGroupOrder: 10, isPinned: true })
    const u1 = makeRepo('u1', { projectGroupId: 'g1', projectGroupOrder: 0, isPinned: false })
    const u2 = makeRepo('u2', { projectGroupId: 'g1', projectGroupOrder: 10, isPinned: false })
    const pinnedSet = new Set(['p1', 'p2'])
    const groupHeaderRects = [
      {
        groupId: 'g1',
        bucketKey: 'root',
        headerIndex: 0,
        top: 0,
        bottom: 28,
        sectionBottom: 196
      }
    ]
    const repoHeaderRects = [
      {
        repoId: 'p1',
        bucketKey: 'group:g1',
        headerIndex: 0,
        top: 28,
        bottom: 56,
        sectionBottom: 56
      },
      {
        repoId: 'p2',
        bucketKey: 'group:g1',
        headerIndex: 1,
        top: 56,
        bottom: 84,
        sectionBottom: 84
      },
      {
        repoId: 'u1',
        bucketKey: 'group:g1',
        headerIndex: 2,
        top: 84,
        bottom: 112,
        sectionBottom: 112
      },
      {
        repoId: 'u2',
        bucketKey: 'group:g1',
        headerIndex: 3,
        top: 112,
        bottom: 196,
        sectionBottom: 196
      }
    ]
    const buckets = new Map<string, readonly string[]>([['group:g1', ['p1', 'p2', 'u1', 'u2']]])

    const pinnedPreview = computeCombinedProjectHeaderDropTarget({
      pointerY: 98,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g1',
      draggedRepoPinned: true,
      pinnedRepoHeaderIds: pinnedSet,
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g1']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: buckets,
      contentBottom: 196
    })
    expect(pinnedPreview).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g1',
      dropIndex: 2,
      dropIndicatorY: 87
    })

    const unpinnedPreview = computeCombinedProjectHeaderDropTarget({
      pointerY: 70,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g1',
      draggedRepoPinned: false,
      pinnedRepoHeaderIds: pinnedSet,
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g1']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: buckets,
      contentBottom: 196
    })
    expect(unpinnedPreview).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g1',
      dropIndex: 0,
      dropIndicatorY: 81
    })

    const onCommitProjectGroupOrder = vi.fn()
    await commitProjectHeaderDragDrop({
      session: {
        repo: p1,
        bucketKey: 'group:g1',
        sidebarRepoHeaderIds: ['p1', 'p2']
      },
      dropTarget: pinnedPreview!,
      sidebarRepoHeaderIdsByBucket: buckets,
      pinnedRepoHeaderIds: pinnedSet,
      orderedRepoIds: ['p1', 'p2', 'u1', 'u2'],
      repoById: new Map([
        ['p1', p1],
        ['p2', p2],
        ['u1', u1],
        ['u2', u2]
      ]),
      liveRepos: [p1, p2, u1, u2],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })
    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(p1, 'g1', 11)
  })

  it('targets the destination bucket unpinned tier on cross-bucket drops, including pinned-only, root prefix, and virtualized tail cases', async () => {
    const draggedPinned = makeRepo('r-drag', { isPinned: true })
    const p1 = makeRepo('p1', { projectGroupId: 'g2', projectGroupOrder: 100, isPinned: true })
    const u1 = makeRepo('u1', { projectGroupId: 'g2', projectGroupOrder: 0, isPinned: false })
    const pinnedOnly = makeRepo('p-only', {
      projectGroupId: 'g-pinned-only',
      projectGroupOrder: 5,
      isPinned: true
    })
    const pinnedSet = new Set(['r-drag', 'p1', 'p-only'])

    const mixedPreview = computeCombinedProjectHeaderDropTarget({
      pointerY: 42,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: null,
      draggedRepoPinned: true,
      pinnedRepoHeaderIds: pinnedSet,
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g2']),
      groupHeaderRects: [
        { groupId: 'g2', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28, sectionBottom: 112 }
      ],
      repoHeaderRects: [
        {
          repoId: 'p1',
          bucketKey: 'group:g2',
          headerIndex: 0,
          top: 28,
          bottom: 56,
          sectionBottom: 56
        },
        {
          repoId: 'u1',
          bucketKey: 'group:g2',
          headerIndex: 1,
          top: 56,
          bottom: 84,
          sectionBottom: 112
        }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['r-drag']],
        ['group:g2', ['p1', 'u1']]
      ]),
      contentBottom: 140
    })
    expect(mixedPreview).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g2',
      dropIndex: 0,
      dropIndicatorY: 53
    })

    const onCommitProjectGroupOrder = vi.fn()
    await commitProjectHeaderDragDrop({
      session: {
        repo: draggedPinned,
        bucketKey: 'ungrouped',
        sidebarRepoHeaderIds: ['r-drag']
      },
      dropTarget: mixedPreview!,
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['r-drag']],
        ['group:g2', ['p1', 'u1']]
      ]),
      pinnedRepoHeaderIds: pinnedSet,
      orderedRepoIds: ['r-drag', 'p1', 'u1'],
      repoById: new Map([
        ['r-drag', draggedPinned],
        ['p1', p1],
        ['u1', u1]
      ]),
      liveRepos: [draggedPinned, p1, u1],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })
    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(draggedPinned, 'g2', -1)

    const pinnedOnlyPreview = computeCombinedProjectHeaderDropTarget({
      pointerY: 45,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: null,
      draggedRepoPinned: true,
      pinnedRepoHeaderIds: pinnedSet,
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-pinned-only']),
      groupHeaderRects: [
        {
          groupId: 'g-pinned-only',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 96
        }
      ],
      repoHeaderRects: [
        {
          repoId: 'p-only',
          bucketKey: 'group:g-pinned-only',
          headerIndex: 0,
          top: 28,
          bottom: 56,
          sectionBottom: 96
        }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['r-drag']],
        ['group:g-pinned-only', ['p-only']]
      ]),
      contentBottom: 140
    })
    expect(pinnedOnlyPreview).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g-pinned-only',
      dropIndex: 0,
      dropIndicatorY: 100
    })
    expect(pinnedOnly.projectGroupOrder).toBe(5)

    const overRootPinnedPrefix = computeCombinedProjectHeaderDropTarget({
      pointerY: 335,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g1',
      draggedRepoPinned: false,
      pinnedRepoHeaderIds: new Set(['rp1', 'rp2']),
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g1']),
      groupHeaderRects: [
        { groupId: 'g1', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28, sectionBottom: 120 }
      ],
      repoHeaderRects: [
        {
          repoId: 'rp1',
          bucketKey: 'ungrouped',
          headerIndex: 0,
          top: 300,
          bottom: 328,
          sectionBottom: 328
        },
        {
          repoId: 'rp2',
          bucketKey: 'ungrouped',
          headerIndex: 1,
          top: 340,
          bottom: 368,
          sectionBottom: 410
        },
        {
          repoId: 'ru1',
          bucketKey: 'ungrouped',
          headerIndex: 2,
          top: 420,
          bottom: 448,
          sectionBottom: 448
        }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g1', ['r-drag']],
        ['ungrouped', ['rp1', 'rp2', 'ru1']]
      ]),
      contentBottom: 460
    })
    expect(overRootPinnedPrefix).toEqual({
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 0,
      dropIndicatorY: 416
    })

    const virtualizedPinnedTail = computeCombinedProjectHeaderDropTarget({
      pointerY: 315,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g1',
      draggedRepoPinned: false,
      pinnedRepoHeaderIds: new Set(['rp1', 'rp2']),
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g1']),
      groupHeaderRects: [
        { groupId: 'g1', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28, sectionBottom: 120 }
      ],
      repoHeaderRects: [
        {
          repoId: 'rp1',
          bucketKey: 'ungrouped',
          headerIndex: 0,
          top: 300,
          bottom: 328,
          sectionBottom: 328
        }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g1', ['r-drag']],
        ['ungrouped', ['rp1', 'rp2']]
      ]),
      contentBottom: 600
    })
    expect(virtualizedPinnedTail).toBeNull()
  })

  it('halts remaining mixed-child updates in commitProjectGroupHeaderDragDrop when an order write returns false', async () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const subA = makeGroup('sub-a', { parentGroupId: 'g1', tabOrder: 0 })
    const subDrag = makeGroup('sub-drag', { parentGroupId: 'g1', tabOrder: 3 })
    const subStay = makeGroup('sub-stay', { parentGroupId: 'g1', tabOrder: 0 })
    const p1 = makeRepo('p1', { projectGroupId: 'g1', projectGroupOrder: 0 })
    const projectGroupById = new Map([
      ['g1', parent],
      ['sub-a', subA],
      ['sub-drag', subDrag],
      ['sub-stay', subStay]
    ])
    const sidebarGroupChildItemIdsByGroupId = new Map([
      ['g1', ['group:sub-a', 'repo:p1', 'group:sub-stay', 'group:sub-drag'] as const]
    ])
    const sidebarProjectGroupHeaderIdsByBucket = new Map([
      ['root', ['g1']],
      ['parent:g1', ['sub-a', 'sub-stay', 'sub-drag']]
    ])

    const onGroupUpdateRejected = vi.fn().mockResolvedValueOnce(false)
    const onRepoOrderNever = vi.fn().mockResolvedValue(true)
    await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'sub-drag', bucketKey: 'parent:g1' },
      dropTarget: { kind: 'slot', targetBucketKey: 'parent:g1', dropIndex: 1, dropIndicatorY: 28 },
      projectGroupById,
      repos: [p1],
      allowMixedProjectReorder: true,
      sidebarGroupChildItemIdsByGroupId,
      repoById: new Map([['p1', p1]]),
      orderedRepoIds: ['p1'],
      sidebarProjectGroupHeaderIdsByBucket,
      onCommitProjectGroupUpdate: onGroupUpdateRejected,
      onCommitProjectGroupOrder: onRepoOrderNever
    })
    expect(onGroupUpdateRejected).toHaveBeenCalledTimes(1)
    expect(onRepoOrderNever).not.toHaveBeenCalled()

    const onGroupUpdate = vi.fn().mockResolvedValue(true)
    const onRepoOrderRejected = vi.fn().mockResolvedValueOnce(false)
    await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'sub-drag', bucketKey: 'parent:g1' },
      dropTarget: { kind: 'slot', targetBucketKey: 'parent:g1', dropIndex: 1, dropIndicatorY: 28 },
      projectGroupById,
      repos: [p1],
      allowMixedProjectReorder: true,
      sidebarGroupChildItemIdsByGroupId,
      repoById: new Map([['p1', p1]]),
      orderedRepoIds: ['p1'],
      sidebarProjectGroupHeaderIdsByBucket,
      onCommitProjectGroupUpdate: onGroupUpdate,
      onCommitProjectGroupOrder: onRepoOrderRejected
    })
    expect(onGroupUpdate).toHaveBeenCalledTimes(1)
    expect(onRepoOrderRejected).toHaveBeenCalledTimes(1)
  })

  it('inserts at index 0 of the unpinned tier when exiting a pinned parent group or pinned subgroup', () => {
    const gp = makeGroup('gp', { tabOrder: 0 })
    const pinnedParent = makeGroup('p-sub', { parentGroupId: 'gp', tabOrder: 0, isPinned: true })
    const uSub1 = makeGroup('u-sub1', { parentGroupId: 'gp', tabOrder: 1, isPinned: false })
    const uSub2 = makeGroup('u-sub2', { parentGroupId: 'gp', tabOrder: 2, isPinned: false })
    const leafGroup = makeGroup('leaf', { parentGroupId: 'p-sub', tabOrder: 0 })
    const leafRepo = makeRepo('leaf-repo', { projectGroupId: 'p-sub', projectGroupOrder: 0 })
    const projectGroupById = new Map([
      ['gp', gp],
      ['p-sub', pinnedParent],
      ['u-sub1', uSub1],
      ['u-sub2', uSub2],
      ['leaf', leafGroup]
    ])
    const sidebarGroupChildItemIdsByGroupId = new Map([
      ['gp', ['group:p-sub', 'group:u-sub1', 'group:u-sub2'] as const],
      ['p-sub', ['group:leaf', 'repo:leaf-repo'] as const]
    ])
    const sidebarProjectGroupHeaderIdsByBucket = new Map([
      ['root', ['gp']],
      ['parent:gp', ['p-sub', 'u-sub1', 'u-sub2']],
      ['parent:p-sub', ['leaf']]
    ])
    const virtualizedGroupRects = [
      { groupId: 'gp', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28, sectionBottom: 96 },
      {
        groupId: 'p-sub',
        bucketKey: 'parent:gp',
        headerIndex: 0,
        top: 28,
        bottom: 56,
        sectionBottom: 96
      },
      {
        groupId: 'leaf',
        bucketKey: 'parent:p-sub',
        headerIndex: 0,
        top: 56,
        bottom: 96,
        sectionBottom: 96
      }
    ]

    expect(
      computeCombinedProjectGroupHeaderDropTarget({
        pointerY: 104,
        containerTop: 0,
        scrollTop: 0,
        draggedGroup: leafGroup,
        projectGroupById,
        reparentableGroupIds: new Set(['gp', 'u-sub1', 'u-sub2']),
        groupHeaderRects: virtualizedGroupRects,
        allowMixedProjectReorder: true,
        sidebarGroupChildItemIdsByGroupId,
        sidebarProjectGroupHeaderIdsByBucket,
        contentBottom: 220
      })
    ).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:gp',
      dropIndex: 0,
      dropIndicatorY: 100
    })

    expect(
      computeCombinedProjectGroupHeaderDropTarget({
        pointerY: 104,
        containerTop: 0,
        scrollTop: 0,
        draggedGroup: leafGroup,
        projectGroupById,
        reparentableGroupIds: new Set(['gp', 'u-sub1', 'u-sub2']),
        groupHeaderRects: virtualizedGroupRects,
        allowMixedProjectReorder: false,
        sidebarProjectGroupHeaderIdsByBucket,
        contentBottom: 220
      })
    ).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:gp',
      dropIndex: 0,
      dropIndicatorY: 100
    })

    expect(
      computeCombinedProjectHeaderDropTarget({
        pointerY: 112,
        containerTop: 0,
        scrollTop: 0,
        currentGroupId: 'p-sub',
        currentParentGroupId: 'gp',
        draggedRepoPinned: false,
        projectGroupById,
        repoById: new Map([['leaf-repo', leafRepo]]),
        sidebarGroupChildItemIdsByGroupId,
        allowSlotReorder: true,
        joinableGroupIds: new Set(['gp', 'p-sub', 'u-sub1', 'u-sub2']),
        groupHeaderRects: virtualizedGroupRects,
        repoHeaderRects: [],
        sidebarRepoHeaderIdsByBucket: new Map([['group:p-sub', ['leaf-repo']]]),
        contentBottom: 220
      })
    ).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:gp',
      dropIndex: 0,
      dropIndicatorY: 98
    })
  })

  it('reindexes host-filtered group rects when resolving a cross-bucket drop into a pinned-only bucket after another host section', () => {
    const remoteG1 = makeGroup('remote-g1', { executionHostId: 'runtime:remote', tabOrder: 0 })
    const remoteG2 = makeGroup('remote-g2', { executionHostId: 'runtime:remote', tabOrder: 1 })
    const localPinned = makeGroup('local-pinned', {
      executionHostId: 'local',
      tabOrder: 0,
      isPinned: true
    })
    const localSub = makeGroup('local-sub', {
      executionHostId: 'local',
      parentGroupId: 'local-pinned',
      tabOrder: 0
    })
    const projectGroupById = new Map([
      ['remote-g1', remoteG1],
      ['remote-g2', remoteG2],
      ['local-pinned', localPinned],
      ['local-sub', localSub]
    ])

    const target = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 280,
      containerTop: 0,
      scrollTop: 0,
      dragHostId: 'local',
      draggedGroup: localSub,
      projectGroupById,
      reparentableGroupIds: new Set(['local-pinned']),
      hostHeaderRects: [
        { hostId: 'runtime:remote', top: 0, bottom: 28 },
        { hostId: 'local', top: 180, bottom: 208 }
      ],
      groupHeaderRects: [
        {
          groupId: 'local-pinned',
          bucketKey: 'root',
          headerIndex: 2,
          top: 208,
          bottom: 236,
          sectionBottom: 268
        },
        {
          groupId: 'local-sub',
          bucketKey: 'parent:local-pinned',
          headerIndex: 0,
          top: 236,
          bottom: 268,
          sectionBottom: 268
        }
      ],
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['remote-g1', 'remote-g2', 'local-pinned']],
        ['parent:local-pinned', ['local-sub']]
      ]),
      contentBottom: 268
    })

    expect(target).toEqual({
      kind: 'slot',
      targetBucketKey: 'root',
      dropIndex: 0,
      dropIndicatorY: 272
    })
  })
})
