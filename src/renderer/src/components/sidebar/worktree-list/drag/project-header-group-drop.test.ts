import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
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

  it('resolves destination siblings from liveRepos on the localized registration host rather than repoById anchor twin ranks', async () => {
    const draggedLocal = makeRepo('r-drag', { executionHostId: 'local' })
    const draggedRemote = makeRepo('r-drag', {
      executionHostId: 'runtime:env-1',
      projectGroupId: 'src-remote',
      projectGroupOrder: 0
    })
    const sib1Local = makeRepo('sib-1', {
      executionHostId: 'local',
      projectGroupId: 'dst-remote',
      projectGroupOrder: 100
    })
    const sib2Local = makeRepo('sib-2', {
      executionHostId: 'local',
      projectGroupId: 'dst-remote',
      projectGroupOrder: 200
    })
    const sib1Remote = makeRepo('sib-1', {
      executionHostId: 'runtime:env-1',
      projectGroupId: 'dst-remote',
      projectGroupOrder: 0
    })
    const sib2Remote = makeRepo('sib-2', {
      executionHostId: 'runtime:env-1',
      projectGroupId: 'dst-remote',
      projectGroupOrder: 10
    })
    const onCommitProjectGroupOrder = vi.fn()

    await commitProjectHeaderDragDrop({
      session: {
        repo: draggedLocal,
        groupRepo: draggedRemote,
        bucketKey: 'group:src-remote',
        sidebarRepoHeaderIds: ['r-drag']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:dst-remote',
        dropIndex: 1,
        dropIndicatorY: 70
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:src-remote', ['r-drag']],
        ['group:dst-remote', ['sib-1', 'sib-2']]
      ]),
      orderedRepoIds: ['r-drag', 'sib-1', 'sib-2'],
      repoById: new Map([
        ['r-drag', draggedLocal],
        ['sib-1', sib1Local],
        ['sib-2', sib2Local]
      ]),
      liveRepos: [draggedLocal, draggedRemote, sib1Local, sib2Local, sib1Remote, sib2Remote],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(draggedRemote, 'dst-remote', 5)
  })

  it('ignores joinable groups in other host sections when locating the empty-root drop zone', () => {
    const target = computeCombinedProjectHeaderDropTarget({
      pointerY: 140,
      containerTop: 0,
      scrollTop: 0,
      dragHostId: 'local',
      currentGroupId: 'g-local',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-local', 'g-ssh']),
      hostHeaderRects: [
        { hostId: 'local', top: 0, bottom: 20 },
        { hostId: 'ssh:box', top: 160, bottom: 180 }
      ],
      groupHeaderRects: [
        {
          groupId: 'g-local',
          bucketKey: 'root',
          headerIndex: 0,
          top: 20,
          bottom: 48,
          sectionBottom: 120
        },
        {
          groupId: 'g-ssh',
          bucketKey: 'root',
          headerIndex: 1,
          top: 180,
          bottom: 208,
          sectionBottom: 280
        }
      ],
      repoHeaderRects: [
        { repoId: 'r-local', bucketKey: 'group:g-local', headerIndex: 0, top: 48, bottom: 76 }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g-local', ['r-local']],
        ['ungrouped', []]
      ]),
      contentBottom: 280
    })

    expect(target).toEqual({
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 0,
      dropIndicatorY: 124
    })
  })

  it('respaces tied destination siblings on cross-bucket slot drop instead of collapsing rank', async () => {
    const dragged = makeRepo('dragged', { projectGroupId: 'g-src', projectGroupOrder: 0 })
    const destA = makeRepo('dest-a', { projectGroupId: 'g-dest', projectGroupOrder: 0 })
    const destB = makeRepo('dest-b', { projectGroupId: 'g-dest', projectGroupOrder: 0 })
    const destC = makeRepo('dest-c', { projectGroupId: 'g-dest', projectGroupOrder: 10 })
    const gSrc = makeGroup('g-src', { tabOrder: 0 })
    const gDest = makeGroup('g-dest', { tabOrder: 1 })
    const repos = [dragged, destA, destB, destC]
    const orderCalls: { id: string; groupId: string | null; order: number | null }[] = []

    const committed = await commitProjectHeaderDragDrop({
      session: {
        repo: dragged,
        groupRepo: dragged,
        bucketKey: 'group:g-src',
        sidebarRepoHeaderIds: ['dragged']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:g-dest',
        dropIndex: 1,
        dropIndicatorY: 48
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g-src', ['dragged']],
        ['group:g-dest', ['dest-a', 'dest-b', 'dest-c']]
      ]),
      projectGroups: [gSrc, gDest],
      projectGroupById: new Map([
        ['g-src', gSrc],
        ['g-dest', gDest]
      ]),
      orderedRepoIds: ['dragged', 'dest-a', 'dest-b', 'dest-c'],
      repoById: new Map(repos.map((r) => [r.id, r])),
      liveRepos: repos,
      getLiveRepos: () => repos,
      getLiveProjectGroups: () => [gSrc, gDest],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: async (repo, groupId, order) => {
        orderCalls.push({ id: repo.id, groupId, order })
        const match = repos.find((r) => r.id === repo.id)
        if (match) {
          match.projectGroupId = groupId
          match.projectGroupOrder = order ?? undefined
        }
        return true
      },
      onMoveToGroupHeader: vi.fn()
    })

    expect(committed).toBe(true)
    expect(orderCalls).toEqual([
      { id: 'dragged', groupId: 'g-dest', order: 1 },
      { id: 'dest-b', groupId: 'g-dest', order: 2 },
      { id: 'dest-c', groupId: 'g-dest', order: 3 }
    ])
    expect(destA.projectGroupOrder).toBe(0)
    expect(dragged.projectGroupOrder).toBe(1)
    expect(destB.projectGroupOrder).toBe(2)
    expect(destC.projectGroupOrder).toBe(3)
  })
})
