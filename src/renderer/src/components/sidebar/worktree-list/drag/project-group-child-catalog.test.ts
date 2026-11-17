// @vitest-environment happy-dom
import React from 'react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import {
  getSidebarPinnedRepoHeaderIds,
  isRepoHeaderIdPinned,
  resolveCrossBucketPinnedPrefixSlot
} from './header-drag-pin-tier'
import { getProjectGroupMutationsForDrop } from './project-group-header-drag-commit'
import { useRepoHeaderDrag } from './project-header-drag'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import { computeSessionProjectHeaderDropTarget } from './project-header-drag-start'
import { canRepoStartHeaderDrag } from './project-header-group-drop'

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

describe('project-group-child-catalog pin and hidden-sibling ordering', () => {
  it('resolves host-specific child repo pin state instead of trusting colliding IDs in pinnedRepoHeaderIds', async () => {
    const gLocal = makeGroup('g-local', { executionHostId: 'local', tabOrder: 0 })
    const subLocal = makeGroup('sub-local', {
      executionHostId: 'local',
      parentGroupId: 'g-local',
      tabOrder: 0,
      isPinned: false
    })
    const localSharedUnpinned = makeRepo('shared-id', {
      executionHostId: 'local',
      projectGroupId: 'g-local',
      projectGroupOrder: 10,
      isPinned: false
    })
    const remoteSharedPinned = makeRepo('shared-id', {
      executionHostId: 'runtime:env-1',
      projectGroupId: null,
      isPinned: true
    })
    const liveRepos = [localSharedUnpinned, remoteSharedPinned]
    const collidedRepoById = new Map([['shared-id', remoteSharedPinned]])
    const pinnedRepoHeaderIds = new Set(['shared-id'])
    const projectGroupById = new Map([
      ['g-local', gLocal],
      ['sub-local', subLocal]
    ])
    const childMap = new Map([['g-local', ['group:sub-local', 'repo:shared-id'] as const]])

    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: subLocal,
        sourceBucketKey: 'parent:g-local',
        dropTarget: {
          kind: 'slot',
          targetBucketKey: 'parent:g-local',
          dropIndex: 2,
          dropIndicatorY: 96
        },
        projectGroupById,
        repos: liveRepos,
        allowMixedProjectReorder: true,
        sidebarGroupChildItemIdsByGroupId: childMap,
        repoById: collidedRepoById,
        pinnedRepoHeaderIds,
        orderedRepoIds: ['shared-id'],
        sidebarProjectGroupHeaderIdsByBucket: new Map([
          ['root', ['g-local']],
          ['parent:g-local', ['sub-local']]
        ])
      })
    ).toEqual([{ groupId: 'sub-local', updates: { tabOrder: 11 } }])

    const scrollContainer = document.createElement('div')
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, 300))
    const livePreviewTarget = computeSessionProjectHeaderDropTarget(
      34,
      {
        repo: localSharedUnpinned,
        groupRepo: localSharedUnpinned,
        bucketKey: 'group:g-local',
        sidebarRepoHeaderIds: ['shared-id'],
        joinableGroupIds: new Set(['g-local', 'sub-local']),
        pointerId: 1,
        groupHeaderRects: [
          {
            groupId: 'g-local',
            bucketKey: 'root',
            headerIndex: 0,
            top: 0,
            bottom: 28,
            sectionBottom: 120
          },
          {
            groupId: 'sub-local',
            bucketKey: 'parent:g-local',
            headerIndex: 0,
            top: 32,
            bottom: 60,
            sectionBottom: 60
          }
        ],
        headerRects: [
          {
            repoId: 'shared-id',
            bucketKey: 'group:g-local',
            headerIndex: 0,
            top: 64,
            bottom: 92,
            sectionBottom: 92
          }
        ],
        handleEl: document.createElement('div'),
        startX: 0,
        startY: 70,
        latestPointerY: 34,
        promoted: true
      },
      {
        allowSlotReorder: true,
        projectGroups: [gLocal, subLocal],
        projectGroupById,
        sidebarRepoHeaderIdsByBucket: new Map([['group:g-local', ['shared-id']]]),
        sidebarGroupChildItemIdsByGroupId: childMap,
        pinnedRepoHeaderIds,
        orderedRepoIds: ['shared-id'],
        repoById: collidedRepoById,
        usesProjectGroupOrdering: true,
        getScrollContainer: () => scrollContainer,
        getLiveRepos: () => liveRepos,
        onCommitRepoOrder: vi.fn(),
        onCommitProjectGroupOrder: vi.fn(),
        onMoveToGroupHeader: vi.fn()
      }
    )
    expect(livePreviewTarget).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g-local',
      dropIndex: 0,
      dropIndicatorY: 28
    })

    const localUngroupedShared = makeRepo('shared-id', {
      executionHostId: 'local',
      projectGroupId: null,
      isPinned: false
    })
    const localUngroupedPeer = makeRepo('peer-local', {
      executionHostId: 'local',
      projectGroupId: null,
      isPinned: false
    })
    expect(
      canRepoStartHeaderDrag({
        repo: localUngroupedShared,
        allowSlotReorder: true,
        bucketItemCount: 2,
        bucketHeaderIds: ['shared-id', 'peer-local'],
        pinnedRepoHeaderIds,
        repoById: new Map([
          ['shared-id', remoteSharedPinned],
          ['peer-local', localUngroupedPeer]
        ]),
        liveRepos: [localUngroupedShared, localUngroupedPeer, remoteSharedPinned],
        joinableGroupIds: new Set()
      })
    ).toBe(true)

    const onCommitProjectGroupOrder = vi.fn().mockResolvedValue(true)
    await commitProjectHeaderDragDrop({
      session: {
        repo: localSharedUnpinned,
        groupRepo: localSharedUnpinned,
        bucketKey: 'group:g-local',
        sidebarRepoHeaderIds: ['shared-id']
      },
      dropTarget: livePreviewTarget!,
      sidebarRepoHeaderIdsByBucket: new Map([['group:g-local', ['shared-id']]]),
      sidebarGroupChildItemIdsByGroupId: childMap,
      projectGroupById,
      pinnedRepoHeaderIds,
      orderedRepoIds: ['shared-id'],
      repoById: collidedRepoById,
      liveRepos,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })
    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(localSharedUnpinned, 'g-local', -1)
  })

  it('keeps paired SSH and ProjectGrouping-linked headers in the pinned tier across commit', async () => {
    const gLocal = makeGroup('g-local', { executionHostId: 'local', tabOrder: 0 })
    const pinnedSub = makeGroup('sub-pinned', {
      executionHostId: 'local',
      parentGroupId: 'g-local',
      tabOrder: 5,
      isPinned: true
    })
    const unpinnedSub = makeGroup('sub-unpinned', {
      executionHostId: 'local',
      parentGroupId: 'g-local',
      tabOrder: 20,
      isPinned: false
    })
    const sharedLocal = makeRepo('shared-alpha', {
      executionHostId: 'local',
      projectGroupId: 'g-local',
      projectGroupOrder: 10,
      isPinned: false
    })
    const sharedBuilder = makeRepo('shared-alpha', {
      connectionId: 'builder',
      executionHostId: undefined,
      path: '/srv/shared-alpha',
      isPinned: true
    })
    const linkedLocal = makeRepo('linked-local', {
      executionHostId: 'local',
      projectGroupId: 'g-local',
      projectGroupOrder: 12,
      isPinned: false
    })
    const linkedRemote = makeRepo('linked-remote', {
      connectionId: 'builder',
      executionHostId: undefined,
      path: '/srv/linked',
      isPinned: true
    })
    const headerRows: GroupHeaderRow[] = [
      {
        type: 'header',
        key: 'project:shared-alpha',
        label: 'SharedAlpha',
        count: 1,
        icon: { kind: 'project' },
        hostId: 'local',
        repo: sharedLocal,
        anchorRepo: sharedLocal,
        pinTargetRepos: [sharedLocal, sharedBuilder]
      },
      {
        type: 'header',
        key: 'project:linked',
        label: 'Linked',
        count: 1,
        icon: { kind: 'project' },
        hostId: 'local',
        repo: linkedLocal,
        pinTargetRepos: [linkedLocal, linkedRemote]
      },
      {
        type: 'header',
        key: 'project:ungrouped-localized',
        label: 'UngroupedLocalized',
        count: 1,
        icon: { kind: 'project' },
        hostId: 'local',
        repo: makeRepo('ug-local', { executionHostId: 'local', isPinned: false }),
        anchorRepo: makeRepo('ug-remote', {
          connectionId: 'builder',
          executionHostId: undefined,
          path: '/srv/ug',
          isPinned: true
        })
      }
    ]
    const pinnedRepoHeaderIds = getSidebarPinnedRepoHeaderIds(headerRows)
    const liveRepos = [sharedLocal, sharedBuilder, linkedLocal, linkedRemote]
    const repoById = new Map(liveRepos.map((repo) => [repo.id, repo]))
    const projectGroupById = new Map([
      ['g-local', gLocal],
      ['sub-pinned', pinnedSub],
      ['sub-unpinned', unpinnedSub]
    ])
    const childMap = new Map([
      [
        'g-local',
        [
          'group:sub-pinned',
          'repo:shared-alpha',
          'repo:linked-local',
          'group:sub-unpinned'
        ] as const
      ]
    ])

    const onCommitShared = vi.fn().mockResolvedValue(true)
    await commitProjectHeaderDragDrop({
      session: {
        repo: sharedLocal,
        groupRepo: sharedLocal,
        bucketKey: 'group:g-local',
        sidebarRepoHeaderIds: ['shared-alpha', 'linked-local']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:g-local',
        dropIndex: 0,
        dropIndicatorY: 28
      },
      sidebarRepoHeaderIdsByBucket: new Map([['group:g-local', ['shared-alpha', 'linked-local']]]),
      sidebarGroupChildItemIdsByGroupId: childMap,
      projectGroupById,
      pinnedRepoHeaderIds,
      orderedRepoIds: ['shared-alpha', 'linked-local', 'linked-remote'],
      repoById,
      liveRepos,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: onCommitShared,
      onMoveToGroupHeader: vi.fn()
    })
    expect(onCommitShared).toHaveBeenCalledWith(sharedLocal, 'g-local', 4)

    const onCommitLinked = vi.fn().mockResolvedValue(true)
    await commitProjectHeaderDragDrop({
      session: {
        repo: linkedLocal,
        groupRepo: linkedLocal,
        bucketKey: 'group:g-local',
        sidebarRepoHeaderIds: ['shared-alpha', 'linked-local']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:g-local',
        dropIndex: 0,
        dropIndicatorY: 28
      },
      sidebarRepoHeaderIdsByBucket: new Map([['group:g-local', ['shared-alpha', 'linked-local']]]),
      sidebarGroupChildItemIdsByGroupId: childMap,
      projectGroupById,
      pinnedRepoHeaderIds,
      orderedRepoIds: ['shared-alpha', 'linked-local', 'linked-remote'],
      repoById,
      liveRepos,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: onCommitLinked,
      onMoveToGroupHeader: vi.fn()
    })
    expect(onCommitLinked).toHaveBeenCalledWith(linkedLocal, 'g-local', 4)

    expect(
      canRepoStartHeaderDrag({
        repo: makeRepo('ug-local', { executionHostId: 'local', isPinned: false }),
        allowSlotReorder: true,
        bucketItemCount: 2,
        bucketHeaderIds: ['ug-remote', 'shared-alpha'],
        pinnedRepoHeaderIds,
        repoById,
        liveRepos,
        ownerHostId: 'local',
        joinableGroupIds: new Set()
      })
    ).toBe(true)

    const linkedAnchoredChildMap = new Map([
      [
        'g-local',
        [
          'group:sub-pinned',
          'repo:shared-alpha',
          'repo:linked-remote-anchored',
          'group:sub-unpinned'
        ] as const
      ]
    ])
    const linkedRemoteAnchored = makeRepo('linked-remote-anchored', {
      connectionId: 'builder',
      executionHostId: undefined,
      path: '/srv/linked-anchored',
      projectGroupId: 'g-local',
      projectGroupOrder: 12,
      isPinned: true
    })
    const onCommitAnchoredLinked = vi.fn().mockResolvedValue(true)
    await commitProjectHeaderDragDrop({
      session: {
        repo: linkedRemoteAnchored,
        groupRepo: linkedLocal,
        bucketKey: 'group:g-local',
        sidebarRepoHeaderIds: ['shared-alpha', 'linked-remote-anchored']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:g-local',
        dropIndex: 0,
        dropIndicatorY: 28
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g-local', ['shared-alpha', 'linked-remote-anchored']]
      ]),
      sidebarGroupChildItemIdsByGroupId: linkedAnchoredChildMap,
      projectGroupById,
      pinnedRepoHeaderIds: getSidebarPinnedRepoHeaderIds([
        ...headerRows,
        {
          type: 'header',
          key: 'project:linked-anchored',
          label: 'LinkedAnchored',
          count: 1,
          icon: { kind: 'project' },
          hostId: 'local',
          repo: linkedLocal,
          anchorRepo: linkedRemoteAnchored,
          pinTargetRepos: [linkedLocal, linkedRemoteAnchored]
        }
      ]),
      orderedRepoIds: ['shared-alpha', 'linked-local', 'linked-remote-anchored'],
      repoById: new Map([...repoById, ['linked-remote-anchored', linkedRemoteAnchored]]),
      liveRepos: [...liveRepos, linkedRemoteAnchored],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: onCommitAnchoredLinked,
      onMoveToGroupHeader: vi.fn()
    })
    expect(onCommitAnchoredLinked).toHaveBeenCalledWith(linkedLocal, 'g-local', 4)

    const runRepoDragMoveAndDrop = (args: {
      draggedRepo: Repo
      headerIds: string[]
      pinnedIds: ReadonlySet<string>
      repoMap: ReadonlyMap<string, Repo>
      repos: readonly Repo[]
      orderedRepoIds: string[]
      startY: number
      endY: number
      onCommitRepoOrder: (orderedIds: string[]) => void
    }): void => {
      const scrollContainer = document.createElement('div')
      vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, 240, 300)
      )
      const virtualList = document.createElement('div')
      virtualList.dataset.worktreeVirtualList = 'true'
      virtualList.style.height = '120px'
      scrollContainer.append(virtualList)
      args.headerIds.forEach((id, index) => {
        const header = document.createElement('div')
        header.dataset.repoHeaderId = id
        header.dataset.repoHeaderBucket = 'ungrouped'
        header.dataset.repoHeaderIndex = String(index)
        const top = index * 32
        vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 240, 28))
        virtualList.append(header)
      })
      document.body.append(scrollContainer)

      function Harness(): React.JSX.Element {
        const drag = useRepoHeaderDrag({
          orderedRepoIds: args.orderedRepoIds,
          sidebarRepoHeaderIdsByBucket: new Map([['ungrouped', args.headerIds]]),
          pinnedRepoHeaderIds: args.pinnedIds,
          repoById: args.repoMap,
          projectGroups: [],
          getLiveRepos: () => args.repos,
          allowSlotReorder: true,
          usesProjectGroupOrdering: false,
          onCommitRepoOrder: args.onCommitRepoOrder,
          onCommitProjectGroupOrder: vi.fn(),
          onMoveToGroupHeader: vi.fn(),
          getScrollContainer: () => scrollContainer
        })
        return React.createElement('div', {
          'data-repo-header-drag-handle': 'true',
          onPointerDown: (event: React.PointerEvent<HTMLElement>) =>
            drag.onHandlePointerDown(event, args.draggedRepo, args.draggedRepo)
        })
      }

      const view = render(React.createElement(Harness))
      const handle = view.container.firstElementChild!
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0, clientY: args.startY })
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 1,
          clientX: 0,
          clientY: args.endY,
          buttons: 1
        })
      )
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: args.endY })
      )
      view.unmount()
      scrollContainer.remove()
    }

    const ugLocal = makeRepo('ug-local', { executionHostId: 'local', isPinned: false })
    const ugRemoteRuntime = makeRepo('ug-local', {
      executionHostId: 'runtime:env-1',
      isPinned: true
    })
    const ugPeer = makeRepo('ug-peer', { executionHostId: 'local', isPinned: false })
    const onCommitUnpinnedReorder = vi.fn()
    runRepoDragMoveAndDrop({
      draggedRepo: ugLocal,
      headerIds: ['ug-local', 'ug-peer'],
      pinnedIds: new Set(['ug-local']),
      repoMap: new Map([
        ['ug-local', ugRemoteRuntime],
        ['ug-peer', ugPeer]
      ]),
      repos: [ugLocal, ugRemoteRuntime, ugPeer],
      orderedRepoIds: ['ug-local', 'ug-peer'],
      startY: 14,
      endY: 56,
      onCommitRepoOrder: onCommitUnpinnedReorder
    })
    expect(onCommitUnpinnedReorder).toHaveBeenCalledWith(['ug-peer', 'ug-local'])

    const pinnedLocal = makeRepo('pinned-local', { executionHostId: 'local', isPinned: true })
    const sharedUngroupedLocal = { ...sharedLocal, projectGroupId: null }
    const sharedUngroupedBuilder = { ...sharedBuilder, projectGroupId: null }
    const onCommitPairedPinnedReorder = vi.fn()
    runRepoDragMoveAndDrop({
      draggedRepo: sharedUngroupedLocal,
      headerIds: ['pinned-local', 'shared-alpha'],
      pinnedIds: new Set(),
      repoMap: new Map([
        ['pinned-local', pinnedLocal],
        ['shared-alpha', sharedUngroupedLocal]
      ]),
      repos: [pinnedLocal, sharedUngroupedLocal, sharedUngroupedBuilder],
      orderedRepoIds: ['pinned-local', 'shared-alpha'],
      startY: 46,
      endY: 4,
      onCommitRepoOrder: onCommitPairedPinnedReorder
    })
    expect(onCommitPairedPinnedReorder).toHaveBeenCalledWith(['shared-alpha', 'pinned-local'])
  })

  it('merges hidden children by stored manual rank during mid-list and append reindexing without changing seeded visible order', () => {
    const parent = makeGroup('g-filter', { tabOrder: 0 })
    const hiddenZero = makeRepo('r-hidden-0', {
      projectGroupId: 'g-filter',
      projectGroupOrder: 0
    })
    const visA = makeRepo('r-vis-a', {
      projectGroupId: 'g-filter',
      projectGroupOrder: 1000
    })
    const visSubB = makeGroup('sub-vis-b', {
      parentGroupId: 'g-filter',
      tabOrder: 1000
    })
    const hiddenTail = makeRepo('r-hidden-tail', {
      projectGroupId: 'g-filter',
      projectGroupOrder: 5000
    })
    const incoming = makeGroup('g-incoming', { tabOrder: 1 })
    const repos = [hiddenZero, visA, hiddenTail]

    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: incoming,
        sourceBucketKey: 'root',
        dropTarget: {
          kind: 'slot',
          targetBucketKey: 'parent:g-filter',
          dropIndex: 1,
          dropIndicatorY: 60
        },
        projectGroupById: new Map([
          ['g-filter', parent],
          ['sub-vis-b', visSubB],
          ['g-incoming', incoming]
        ]),
        repos,
        allowMixedProjectReorder: true,
        sidebarGroupChildItemIdsByGroupId: new Map([
          ['g-filter', ['repo:r-vis-a', 'group:sub-vis-b'] as const]
        ]),
        repoById: new Map(repos.map((repo) => [repo.id, repo])),
        orderedRepoIds: repos.map((repo) => repo.id),
        sidebarProjectGroupHeaderIdsByBucket: new Map([
          ['root', ['g-filter', 'g-incoming']],
          ['parent:g-filter', ['sub-vis-b']]
        ])
      })
    ).toEqual([
      { kind: 'repo', repo: visA, projectGroupId: 'g-filter', order: 1 },
      { groupId: 'g-incoming', updates: { parentGroupId: 'g-filter', tabOrder: 2 } },
      { groupId: 'sub-vis-b', updates: { tabOrder: 3 } },
      { kind: 'repo', repo: hiddenTail, projectGroupId: 'g-filter', order: 4 }
    ])

    const visLegacyUnranked = makeRepo('r-vis-legacy', { projectGroupId: 'g-filter' })
    const appendRepos = [hiddenZero, visLegacyUnranked]
    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: incoming,
        sourceBucketKey: 'root',
        dropTarget: { kind: 'group-header', groupId: 'g-filter' },
        projectGroupById: new Map([
          ['g-filter', parent],
          ['sub-vis-b', visSubB],
          ['g-incoming', incoming]
        ]),
        repos: appendRepos,
        allowMixedProjectReorder: true,
        sidebarGroupChildItemIdsByGroupId: new Map([
          ['g-filter', ['group:sub-vis-b', 'repo:r-vis-legacy'] as const]
        ]),
        repoById: new Map(appendRepos.map((repo) => [repo.id, repo])),
        orderedRepoIds: ['r-hidden-0', 'r-vis-legacy'],
        sidebarProjectGroupHeaderIdsByBucket: new Map([
          ['root', ['g-filter', 'g-incoming']],
          ['parent:g-filter', ['sub-vis-b']]
        ])
      })
    ).toEqual([
      { groupId: 'sub-vis-b', updates: { tabOrder: 1 } },
      { kind: 'repo', repo: visLegacyUnranked, projectGroupId: 'g-filter', order: 2 },
      { groupId: 'g-incoming', updates: { parentGroupId: 'g-filter', tabOrder: 3 } }
    ])
  })

  it('recognizes collapsed pinned local repo despite visible unpinned remote twin and preserves non-zero prefix headerIndex', () => {
    const collapsedLocalPinned = makeRepo('twin-x', {
      executionHostId: 'local',
      projectGroupId: 'g-collapsed',
      isPinned: true
    })
    const visibleSshUnpinned = makeRepo('twin-x', {
      connectionId: 'builder',
      executionHostId: undefined,
      path: '/srv/twin-x',
      isPinned: false
    })
    const pinnedIds = getSidebarPinnedRepoHeaderIds([
      {
        type: 'header',
        key: 'project:twin-x:ssh',
        label: 'TwinX',
        count: 1,
        icon: { kind: 'project' },
        hostId: 'ssh:builder',
        repo: visibleSshUnpinned
      }
    ])
    const repoById = new Map([['twin-x', collapsedLocalPinned]])

    expect(
      isRepoHeaderIdPinned('twin-x', pinnedIds, repoById, 'local', [
        collapsedLocalPinned,
        visibleSshUnpinned
      ])
    ).toBe(true)
    expect(
      isRepoHeaderIdPinned('twin-x', pinnedIds, repoById, 'ssh:builder', [
        collapsedLocalPinned,
        visibleSshUnpinned
      ])
    ).toBe(false)

    expect(
      resolveCrossBucketPinnedPrefixSlot({
        tierHeaderCount: 1,
        tierRects: [{ headerIndex: 4, top: 120, bottom: 148 }],
        allBucketHeaderCount: 5,
        allBucketRects: [{ headerIndex: 4, top: 120, bottom: 148 }],
        localY: 96,
        scrollTop: 0
      })
    ).toEqual({
      dropIndex: 4,
      dropIndicatorY: 116
    })
  })
})
