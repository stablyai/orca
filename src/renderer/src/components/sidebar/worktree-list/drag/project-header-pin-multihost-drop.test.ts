import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
import type { Repo } from '../../../../../../shared/repo-types'
import { appendProjectGroupSections } from '../../../../../../shared/sidebar-list/project-group-sections'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import type { OrderedGroupEntry } from '../../../../../../shared/sidebar-list/worktree-group-entry'
import { computeAppendedProjectGroupTabOrder } from './project-group-child-drop-commit'
import { getProjectGroupMutationsForDrop } from './project-group-header-drag-commit'
import { computeCombinedProjectGroupHeaderDropTarget } from './project-group-header-reparent-drop'
import { computeCombinedProjectHeaderDropTarget } from './project-header-group-drop'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import { getRootProjectOrderUpdatesForSidebarDrop } from './root-project-header-drop'

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

describe('project header pin multi-host and collapsed-group drop scoping', () => {
  it('includes hidden children of a collapsed destination group when computing append ranks and retains owner-host child repos via liveRepos', () => {
    const gCollapsed = makeGroup('g-collapsed', { isCollapsed: true, tabOrder: 0 })
    const hiddenSub = makeGroup('hidden-sub', { parentGroupId: 'g-collapsed', tabOrder: 3 })
    const gMoving = makeGroup('g-moving', { tabOrder: 1 })
    const hiddenRepo = makeRepo('hidden-repo', {
      projectGroupId: 'g-collapsed',
      projectGroupOrder: 7
    })
    const projectGroupById = new Map([
      ['g-collapsed', gCollapsed],
      ['hidden-sub', hiddenSub],
      ['g-moving', gMoving]
    ])
    const repoById = new Map([['hidden-repo', hiddenRepo]])
    const emptyChildMap = new Map<string, readonly (`group:${string}` | `repo:${string}`)[]>()
    const rootOnlyBuckets = new Map([['root', ['g-collapsed', 'g-moving']]])

    expect(
      computeAppendedProjectGroupTabOrder({
        groupId: 'g-moving',
        parentGroupId: 'g-collapsed',
        ownerHostId: 'local',
        sidebarProjectGroupHeaderIdsByBucket: rootOnlyBuckets,
        sidebarGroupChildItemIdsByGroupId: emptyChildMap,
        projectGroupById,
        repoById,
        liveRepos: [hiddenRepo],
        orderedRepoIds: ['hidden-repo']
      })
    ).toBe(8)

    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: gMoving,
        sourceBucketKey: 'root',
        dropTarget: { kind: 'group-header', groupId: 'g-collapsed' },
        projectGroupById,
        repos: [hiddenRepo],
        allowMixedProjectReorder: true,
        sidebarGroupChildItemIdsByGroupId: emptyChildMap,
        repoById,
        orderedRepoIds: ['hidden-repo'],
        sidebarProjectGroupHeaderIdsByBucket: rootOnlyBuckets
      })
    ).toEqual([{ groupId: 'g-moving', updates: { parentGroupId: 'g-collapsed', tabOrder: 8 } }])

    const gLocal = makeGroup('g-local', { executionHostId: 'local', tabOrder: 0 })
    const subLocal = makeGroup('sub-local', {
      executionHostId: 'local',
      parentGroupId: 'g-local',
      tabOrder: 2
    })
    const localSharedRepo = makeRepo('shared-id', {
      executionHostId: 'local',
      projectGroupId: 'g-local',
      projectGroupOrder: 0
    })
    const remoteSharedRepo = makeRepo('shared-id', {
      executionHostId: 'runtime:remote',
      projectGroupId: null
    })
    const collidedRepoById = new Map([['shared-id', remoteSharedRepo]])

    const previewAboveSharedLocalRepo = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 36,
      containerTop: 0,
      scrollTop: 0,
      dragHostId: 'local',
      draggedGroup: subLocal,
      projectGroupById: new Map([
        ['g-local', gLocal],
        ['sub-local', subLocal]
      ]),
      reparentableGroupIds: new Set(['g-local']),
      groupHeaderRects: [
        {
          groupId: 'g-local',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 96
        },
        {
          groupId: 'sub-local',
          bucketKey: 'parent:g-local',
          headerIndex: 0,
          top: 64,
          bottom: 96,
          sectionBottom: 96
        }
      ],
      repoHeaderRects: [
        {
          repoId: 'shared-id',
          bucketKey: 'group:g-local',
          headerIndex: 0,
          top: 32,
          bottom: 60,
          sectionBottom: 60
        }
      ],
      allowMixedProjectReorder: true,
      sidebarGroupChildItemIdsByGroupId: new Map([
        ['g-local', ['repo:shared-id', 'group:sub-local'] as const]
      ]),
      repoById: collidedRepoById,
      liveRepos: [localSharedRepo, remoteSharedRepo],
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['g-local']],
        ['parent:g-local', ['sub-local']]
      ]),
      contentBottom: 96
    })

    expect(previewAboveSharedLocalRepo).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:g-local',
      dropIndex: 0,
      dropIndicatorY: 28
    })
  })

  it('stamps explicit projectGroupOrder on legacy unranked sibling repos when interleaving a subgroup between them', () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const legacySub = makeGroup('legacy-sub', { parentGroupId: 'g1', tabOrder: 1 })
    const repoA = makeRepo('repo-a', { projectGroupId: 'g1' })
    const repoB = makeRepo('repo-b', { projectGroupId: 'g1' })

    const mutations = getProjectGroupMutationsForDrop({
      draggedGroup: legacySub,
      sourceBucketKey: 'parent:g1',
      dropTarget: { kind: 'slot', targetBucketKey: 'parent:g1', dropIndex: 1, dropIndicatorY: 60 },
      projectGroupById: new Map([
        ['g1', parent],
        ['legacy-sub', legacySub]
      ]),
      repos: [repoA, repoB],
      allowMixedProjectReorder: true,
      sidebarGroupChildItemIdsByGroupId: new Map([
        ['g1', ['repo:repo-a', 'repo:repo-b', 'group:legacy-sub'] as const]
      ]),
      repoById: new Map([
        ['repo-a', repoA],
        ['repo-b', repoB]
      ]),
      orderedRepoIds: ['repo-a', 'repo-b'],
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['g1']],
        ['parent:g1', ['legacy-sub']]
      ])
    })

    expect(mutations).toEqual([
      { kind: 'repo', repo: repoA, projectGroupId: 'g1', order: 0 },
      { groupId: 'legacy-sub', updates: { tabOrder: 1 } },
      { kind: 'repo', repo: repoB, projectGroupId: 'g1', order: 2 }
    ])
  })

  it('filters ungrouped repo bucket by dragged host and supports ungrouping below interleaved root groups when existing root repos are pinned', async () => {
    const localUngrouped = makeRepo('r-local', { executionHostId: 'local', projectGroupOrder: 0 })
    const remotePinnedRoot = makeRepo('rp-remote', {
      executionHostId: 'runtime:env-1',
      isPinned: true,
      projectGroupOrder: 0
    })
    const remoteRootGroup = makeGroup('g-remote', {
      executionHostId: 'runtime:env-1',
      tabOrder: 0,
      rootProjectOrder: 500
    })
    const remoteGroupedDrag = makeRepo('r-remote-drag', {
      executionHostId: 'runtime:env-1',
      projectGroupId: 'g-remote',
      projectGroupOrder: 0
    })
    const liveRepos = [localUngrouped, remotePinnedRoot, remoteGroupedDrag]
    const repoById = new Map(liveRepos.map((repo) => [repo.id, repo]))
    const projectGroupById = new Map([['g-remote', remoteRootGroup]])

    const afterRemotePinnedRoot = computeCombinedProjectHeaderDropTarget({
      pointerY: 132,
      containerTop: 0,
      scrollTop: 100,
      dragHostId: 'runtime:env-1',
      currentGroupId: 'g-remote',
      draggedRepoPinned: false,
      pinnedRepoHeaderIds: new Set(['rp-remote']),
      repoById,
      liveRepos,
      projectGroupById,
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-remote']),
      hostHeaderRects: [
        { hostId: 'local', top: 0, bottom: 24 },
        { hostId: 'runtime:env-1', top: 200, bottom: 224 }
      ],
      groupHeaderRects: [
        {
          groupId: 'g-remote',
          bucketKey: 'root',
          headerIndex: 0,
          top: 260,
          bottom: 288,
          sectionBottom: 360
        }
      ],
      repoHeaderRects: [
        {
          repoId: 'rp-remote',
          bucketKey: 'ungrouped',
          headerIndex: 1,
          top: 224,
          bottom: 252,
          sectionBottom: 252
        }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['r-local', 'rp-remote']],
        ['group:g-remote', ['r-remote-drag']]
      ]),
      contentBottom: 380
    })
    expect(afterRemotePinnedRoot).toEqual({
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 0,
      dropIndicatorY: 256
    })

    const belowRemoteGroup = computeCombinedProjectHeaderDropTarget({
      pointerY: 272,
      containerTop: 0,
      scrollTop: 100,
      dragHostId: 'runtime:env-1',
      currentGroupId: 'g-remote',
      draggedRepoPinned: false,
      pinnedRepoHeaderIds: new Set(['rp-remote']),
      repoById,
      liveRepos,
      projectGroupById,
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-remote']),
      hostHeaderRects: [
        { hostId: 'local', top: 0, bottom: 24 },
        { hostId: 'runtime:env-1', top: 200, bottom: 224 }
      ],
      groupHeaderRects: [
        {
          groupId: 'g-remote',
          bucketKey: 'root',
          headerIndex: 0,
          top: 260,
          bottom: 288,
          sectionBottom: 360
        }
      ],
      repoHeaderRects: [
        {
          repoId: 'rp-remote',
          bucketKey: 'ungrouped',
          headerIndex: 1,
          top: 224,
          bottom: 252,
          sectionBottom: 252
        }
      ],
      rootProjectHeaderKeys: ['group:g-remote'],
      rootHeaderRects: [
        {
          repoId: 'group:g-remote',
          bucketKey: 'root-interleaved',
          headerIndex: 0,
          top: 260,
          bottom: 288,
          sectionBottom: 360
        }
      ],
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['r-local', 'rp-remote']],
        ['group:g-remote', ['r-remote-drag']]
      ]),
      contentBottom: 380
    })
    expect(belowRemoteGroup).toEqual({
      kind: 'slot',
      targetBucketKey: 'root-interleaved',
      dropIndex: 1,
      dropIndicatorY: 363
    })

    const onCommitProjectGroupOrder = vi.fn().mockResolvedValue(true)
    await commitProjectHeaderDragDrop({
      session: {
        repo: remoteGroupedDrag,
        bucketKey: 'group:g-remote',
        sidebarRepoHeaderIds: ['r-remote-drag'],
        rootProjectHeaderKeys: ['group:g-remote'],
        rootProjectHeaderHostId: 'runtime:env-1'
      },
      dropTarget: belowRemoteGroup!,
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['r-local', 'rp-remote']],
        ['group:g-remote', ['r-remote-drag']]
      ]),
      projectGroups: [remoteRootGroup],
      projectGroupById,
      pinnedRepoHeaderIds: new Set(['rp-remote']),
      orderedRepoIds: ['r-local', 'rp-remote', 'r-remote-drag'],
      repoById,
      liveRepos,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })
    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(remoteGroupedDrag, null, 1500)
  })

  it('orders hidden children of a collapsed group by manual rank so appending lands after the highest-ranked sibling', () => {
    const gCollapsed = makeGroup('g-collapsed', { isCollapsed: true, tabOrder: 0 })
    const hiddenSub = makeGroup('hidden-sub', { parentGroupId: 'g-collapsed', tabOrder: 7 })
    const gMoving = makeGroup('g-moving', { tabOrder: 1 })
    const hiddenRepo = makeRepo('hidden-repo', {
      projectGroupId: 'g-collapsed',
      projectGroupOrder: 2
    })
    const projectGroupById = new Map([
      ['g-collapsed', gCollapsed],
      ['hidden-sub', hiddenSub],
      ['g-moving', gMoving]
    ])

    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: gMoving,
        sourceBucketKey: 'root',
        dropTarget: { kind: 'group-header', groupId: 'g-collapsed' },
        projectGroupById,
        repos: [hiddenRepo],
        allowMixedProjectReorder: true,
        sidebarGroupChildItemIdsByGroupId: new Map(),
        repoById: new Map([['hidden-repo', hiddenRepo]]),
        orderedRepoIds: ['hidden-repo'],
        sidebarProjectGroupHeaderIdsByBucket: new Map([['root', ['g-collapsed', 'g-moving']]])
      })
    ).toEqual([{ groupId: 'g-moving', updates: { parentGroupId: 'g-collapsed', tabOrder: 8 } }])
  })

  it('keeps parent group enclosure when parent header rect is virtualized off-screen during sibling subgroup drag', () => {
    const parent = makeGroup('g-tall', { tabOrder: 0 })
    const sub1 = makeGroup('sub1', { parentGroupId: 'g-tall', tabOrder: 0 })
    const sub2 = makeGroup('sub2', { parentGroupId: 'g-tall', tabOrder: 1 })
    const projectGroupById = new Map([
      ['g-tall', parent],
      ['sub1', sub1],
      ['sub2', sub2]
    ])

    const target = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 160,
      containerTop: 0,
      scrollTop: 100,
      draggedGroup: sub1,
      projectGroupById,
      reparentableGroupIds: new Set(['g-tall', 'sub2']),
      groupHeaderRects: [
        {
          groupId: 'sub1',
          bucketKey: 'parent:g-tall',
          headerIndex: 0,
          top: 100,
          bottom: 128,
          sectionBottom: 196
        },
        {
          groupId: 'sub2',
          bucketKey: 'parent:g-tall',
          headerIndex: 1,
          top: 200,
          bottom: 228,
          sectionBottom: 320
        }
      ],
      rootProjectHeaderKeys: ['group:g-tall'],
      rootHeaderRects: [],
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['g-tall']],
        ['parent:g-tall', ['sub1', 'sub2']]
      ]),
      contentBottom: 360
    })

    expect(target).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:g-tall',
      dropIndex: 2,
      dropIndicatorY: 324
    })
  })

  it('respaces tied root ranks when ungrouping a project onto root-interleaved and includes hidden root groups in computeAppendedProjectGroupTabOrder', async () => {
    const rootGroup = makeGroup('g-root', { tabOrder: 0, rootProjectOrder: 1000 })
    const hiddenRoot = makeGroup('g-hidden-root', { tabOrder: 6 })
    const movingSub = makeGroup('g-sub', { parentGroupId: 'g-root', tabOrder: 0 })
    const tiedRootRepo = makeRepo('r-tied', { projectGroupId: null, projectGroupOrder: 1000 })
    const draggedGroupedRepo = makeRepo('r-drag', {
      projectGroupId: 'g-root',
      projectGroupOrder: 0
    })

    expect(
      computeAppendedProjectGroupTabOrder({
        groupId: 'g-sub',
        parentGroupId: null,
        ownerHostId: 'local',
        sidebarProjectGroupHeaderIdsByBucket: new Map([
          ['root', ['g-root']],
          ['parent:g-root', ['g-sub']]
        ]),
        projectGroupById: new Map([
          ['g-root', rootGroup],
          ['g-hidden-root', hiddenRoot],
          ['g-sub', movingSub]
        ])
      })
    ).toBe(7)

    const committedRepos = [tiedRootRepo, { ...draggedGroupedRepo }]
    let respaceUpdates: ReturnType<typeof getRootProjectOrderUpdatesForSidebarDrop> = []
    await commitProjectHeaderDragDrop({
      session: {
        repo: draggedGroupedRepo,
        groupRepo: draggedGroupedRepo,
        bucketKey: 'group:g-root',
        sidebarRepoHeaderIds: ['r-drag'],
        rootProjectHeaderKeys: ['group:g-root', 'repo:r-tied']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'root-interleaved',
        dropIndex: 1,
        dropIndicatorY: 60
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['r-tied']],
        ['group:g-root', ['r-drag']]
      ]),
      projectGroups: [rootGroup],
      projectGroupById: new Map([['g-root', rootGroup]]),
      orderedRepoIds: ['r-tied', 'r-drag'],
      repoById: new Map([
        ['r-tied', tiedRootRepo],
        ['r-drag', draggedGroupedRepo]
      ]),
      liveRepos: [tiedRootRepo, draggedGroupedRepo],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: async (repo, projectGroupId, order) => {
        const match = committedRepos.find((entry) => entry.id === repo.id)
        if (match) {
          match.projectGroupId = projectGroupId
          match.projectGroupOrder = order
        }
        return true
      },
      onCommitRootProjectOrder: (visibleKeys, draggedKey, dropIndex) => {
        respaceUpdates = getRootProjectOrderUpdatesForSidebarDrop({
          repos: committedRepos,
          projectGroups: [rootGroup],
          visibleKeys,
          draggedKey,
          dropIndex
        })
      },
      onMoveToGroupHeader: vi.fn()
    })

    expect(
      respaceUpdates.map((entry) => ({
        key:
          entry.entry.kind === 'group'
            ? `group:${entry.entry.group.id}`
            : `repo:${entry.entry.repo.id}`,
        order: entry.rootProjectOrder
      }))
    ).toEqual([
      { key: 'repo:r-drag', order: 2000 },
      { key: 'repo:r-tied', order: 3000 }
    ])
  })

  it('reindexes instead of emitting a duplicate rank when float midpoint or endpoint precision is exhausted', async () => {
    const parent = makeGroup('g1', { tabOrder: 0 })
    const subA = makeGroup('sub-a', { parentGroupId: 'g1', tabOrder: 1 })
    const subB = makeGroup('sub-b', { parentGroupId: 'g1', tabOrder: 1 + Number.EPSILON })
    const pDrag = makeRepo('p-drag', { projectGroupId: 'g1', projectGroupOrder: 10 })
    const projectGroupById = new Map([
      ['g1', parent],
      ['sub-a', subA],
      ['sub-b', subB]
    ])
    const committedOrders: { id: string; order: number }[] = []

    await commitProjectHeaderDragDrop({
      session: {
        repo: pDrag,
        groupRepo: pDrag,
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
        ['g1', ['group:sub-a', 'group:sub-b', 'repo:p-drag'] as const]
      ]),
      projectGroupById,
      orderedRepoIds: ['p-drag'],
      repoById: new Map([['p-drag', pDrag]]),
      liveRepos: [pDrag],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: async (repo, _groupId, order) => {
        committedOrders.push({ id: `repo:${repo.id}`, order })
        return true
      },
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        if (updates.tabOrder !== undefined) {
          committedOrders.push({ id: `group:${groupId}`, order: updates.tabOrder })
        }
        return true
      },
      onMoveToGroupHeader: vi.fn()
    })

    expect(committedOrders).toEqual([
      { id: 'group:sub-a', order: 0 },
      { id: 'repo:p-drag', order: 1 },
      { id: 'group:sub-b', order: 2 }
    ])

    const hugeNegSub = makeGroup('sub-neg', {
      parentGroupId: 'g1',
      tabOrder: -(2 ** 54)
    })
    const subIncoming = makeGroup('sub-in', { tabOrder: 1 })
    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: subIncoming,
        sourceBucketKey: 'root',
        dropTarget: {
          kind: 'slot',
          targetBucketKey: 'parent:g1',
          dropIndex: 0,
          dropIndicatorY: 28
        },
        projectGroupById: new Map([
          ['g1', parent],
          ['sub-neg', hugeNegSub],
          ['sub-in', subIncoming]
        ]),
        allowMixedProjectReorder: true,
        sidebarGroupChildItemIdsByGroupId: new Map([['g1', ['group:sub-neg'] as const]]),
        sidebarProjectGroupHeaderIdsByBucket: new Map([
          ['root', ['g1', 'sub-in']],
          ['parent:g1', ['sub-neg']]
        ])
      })
    ).toEqual([
      { groupId: 'sub-in', updates: { parentGroupId: 'g1', tabOrder: 0 } },
      { groupId: 'sub-neg', updates: { tabOrder: 1 } }
    ])
  })

  it('preserves the opposite pin tier mixed group and legacy unranked repo order when assigning an explicit repo rank', async () => {
    const parent = makeGroup('g-parent', { tabOrder: 0 })
    const pinnedSubgroup = makeGroup('sg-pin', {
      parentGroupId: 'g-parent',
      tabOrder: 0,
      isPinned: true
    })
    const fillerA = makeRepo('r-filler-a', { projectGroupId: null })
    const fillerB = makeRepo('r-filler-b', { projectGroupId: null })
    const pinnedLegacyRepo = makeRepo('r-pin', {
      projectGroupId: 'g-parent',
      isPinned: true
    })
    const draggedUnpinnedRepo = makeRepo('r-unpin', {
      projectGroupId: null,
      isPinned: false
    })
    const orderedRepoIds = ['r-filler-a', 'r-filler-b', 'r-pin', 'r-unpin']

    const renderGroupHeaderKeys = (repos: Repo[], groups: ProjectGroup[]): string[] => {
      const result: Row[] = []
      const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
      const orderedGroups: OrderedGroupEntry[] = repos
        .filter((repo) => repo.projectGroupId === 'g-parent')
        .map((repo) => [
          `repo:${repo.id}`,
          { label: repo.displayName, repo, repoIds: new Set([repo.id]), items: [] }
        ])
      appendProjectGroupSections(
        {
          result,
          groupBy: 'repo',
          collapsedGroups: new Set(),
          workspaceStatuses: [],
          repoMap,
          repos,
          pinnedRepoIds: new Set(repos.filter((repo) => repo.isPinned).map((repo) => repo.id)),
          repoOf: (worktree) => repoMap.get(worktree.repoId),
          defaultHostId: 'local',
          hostLabelById: undefined,
          projectIndex: null,
          importedWorktreesByRepo: new Map(),
          newExternalWorktreesInboxByRepo: new Map(),
          pendingByRepo: new Map(),
          mixedWorktreeHostContextLabels: undefined,
          noticeHostContextLabelByRepoId: undefined,
          occurrencePlan: { bySection: new Map(), preferredByIdentity: new Map() },
          folderPairByIdentity: new Map()
        },
        {
          orderedGroups,
          projectGroups: groups,
          folderWorkspaces: [],
          projectOrderBy: 'manual',
          repoOrder: getLogicalRepoOrderRankById(orderedRepoIds)
        }
      )
      return result.flatMap((row) => (row.type === 'header' ? [row.key] : []))
    }

    const initialRepos = [fillerA, fillerB, { ...pinnedLegacyRepo }, { ...draggedUnpinnedRepo }]
    const initialGroups = [{ ...parent }, { ...pinnedSubgroup }]
    expect(renderGroupHeaderKeys(initialRepos, initialGroups)).toEqual([
      'project-group:g-parent',
      'repo:r-pin',
      'project-group:sg-pin'
    ])

    await commitProjectHeaderDragDrop({
      session: {
        repo: draggedUnpinnedRepo,
        groupRepo: draggedUnpinnedRepo,
        bucketKey: 'ungrouped',
        sidebarRepoHeaderIds: ['r-filler-a', 'r-filler-b', 'r-unpin']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:g-parent',
        dropIndex: 0,
        dropIndicatorY: 96
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['r-filler-a', 'r-filler-b', 'r-unpin']],
        ['group:g-parent', ['r-pin']]
      ]),
      // Empty child map exercises collapsed-parent catalog resolution for the pinned tier too
      sidebarGroupChildItemIdsByGroupId: new Map(),
      projectGroupById: new Map(initialGroups.map((entry) => [entry.id, entry])),
      pinnedRepoHeaderIds: new Set(['r-pin']),
      orderedRepoIds,
      repoById: new Map(initialRepos.map((entry) => [entry.id, entry])),
      liveRepos: initialRepos,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: async (repo, projectGroupId, order) => {
        const match = initialRepos.find((entry) => entry.id === repo.id)
        if (match) {
          match.projectGroupId = projectGroupId
          match.projectGroupOrder = order
        }
        return true
      },
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        const match = initialGroups.find((entry) => entry.id === groupId)
        if (match) {
          Object.assign(match, updates)
        }
        return true
      },
      onMoveToGroupHeader: vi.fn()
    })

    expect(renderGroupHeaderKeys(initialRepos, initialGroups)).toEqual([
      'project-group:g-parent',
      'repo:r-pin',
      'project-group:sg-pin',
      'repo:r-unpin'
    ])
  })
})
