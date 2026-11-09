// @vitest-environment happy-dom
import type {
  HostSectionRow,
  HostHeaderRow
} from '../../../../../../shared/sidebar-list/host-section-rows'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import {
  getRootProjectHeaderCountByOccurrenceKey,
  getRootProjectHeaderDragKeys,
  getSidebarRootProjectHeaderKeys,
  measureRootProjectHeaderDragRects,
  getRootProjectOrderForSidebarDrop,
  getRootProjectOrderUpdatesForSidebarDrop
} from './root-project-header-drop'

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

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 1, ...overrides }
}

describe('root project header drops', () => {
  it('moves a project between groups while retaining filtered roots and excluding nested members', () => {
    const order = getRootProjectOrderForSidebarDrop({
      projectGroups: [
        group('a'),
        group('hidden', { tabOrder: 1 }),
        group('b', { tabOrder: 2, executionHostId: 'runtime:remote' }),
        group('nested', { parentGroupId: 'a' })
      ],
      repos: [repo('x'), repo('member', { projectGroupId: 'a' }), repo('y')],
      visibleKeys: ['group:a', 'group:b', 'repo:x', 'repo:y'],
      draggedKey: 'repo:y',
      dropIndex: 1
    })

    expect(order).toMatchObject([
      { kind: 'group', group: { id: 'a' } },
      { kind: 'group', group: { id: 'hidden' } },
      { kind: 'repo', repo: { id: 'y' } },
      { kind: 'group', group: { id: 'b', executionHostId: 'runtime:remote' } },
      { kind: 'repo', repo: { id: 'x' } }
    ])
  })

  it('moves a group below projects without duplicating a project registered on multiple hosts', () => {
    const order = getRootProjectOrderForSidebarDrop({
      projectGroups: [group('a'), group('b', { tabOrder: 1 })],
      repos: [repo('x'), repo('x', { executionHostId: 'runtime:remote' }), repo('hidden')],
      visibleKeys: ['group:a', 'group:b', 'repo:x'],
      draggedKey: 'group:a',
      dropIndex: 3
    })

    expect(order).toMatchObject([
      { kind: 'group', group: { id: 'b' } },
      { kind: 'repo', repo: { id: 'x' } },
      { kind: 'group', group: { id: 'a' } },
      { kind: 'repo', repo: { id: 'hidden' } }
    ])
  })
  it('limits root moves to the source host section', () => {
    expect(
      getRootProjectHeaderDragKeys(
        [
          'group:global',
          'host:local',
          'group:a',
          'repo:x',
          'host:runtime:remote',
          'group:b',
          'repo:y'
        ],
        'repo:x'
      )
    ).toEqual(['group:a', 'repo:x'])
    expect(
      getRootProjectHeaderDragKeys(
        ['host:local', 'group:a', 'host:runtime:remote', 'repo:y'],
        'group:a'
      )
    ).toEqual(['group:a'])
  })

  it('changes only the moved rank when neighbors already have space', () => {
    const updates = getRootProjectOrderUpdatesForSidebarDrop({
      projectGroups: [
        group('a', { rootProjectOrder: 0 }),
        group('b', { rootProjectOrder: 1000, tabOrder: 1 })
      ],
      repos: [repo('x', { projectGroupOrder: 2000 }), repo('y', { projectGroupOrder: 3000 })],
      visibleKeys: ['group:a', 'group:b', 'repo:x', 'repo:y'],
      draggedKey: 'repo:y',
      dropIndex: 1
    })
    expect(updates).toMatchObject([
      { entry: { kind: 'repo', repo: { id: 'y' } }, rootProjectOrder: 500 }
    ])
  })

  it('reindexes roots when there is no representable rank between adjacent neighbors', () => {
    const updates = getRootProjectOrderUpdatesForSidebarDrop({
      projectGroups: [
        group('a', { rootProjectOrder: 9007199254740992 }),
        group('b', { rootProjectOrder: 9007199254740994, tabOrder: 1 })
      ],
      repos: [
        repo('x', { projectGroupOrder: 9007199254740996 }),
        repo('y', { projectGroupOrder: 9007199254740998 })
      ],
      visibleKeys: ['group:a', 'group:b', 'repo:x', 'repo:y'],
      draggedKey: 'repo:y',
      dropIndex: 1
    })
    expect(updates).toMatchObject([
      { entry: { kind: 'group', group: { id: 'a' } }, rootProjectOrder: 0 },
      { entry: { kind: 'repo', repo: { id: 'y' } }, rootProjectOrder: 1000 },
      { entry: { kind: 'group', group: { id: 'b' } }, rootProjectOrder: 2000 },
      { entry: { kind: 'repo', repo: { id: 'x' } }, rootProjectOrder: 3000 }
    ])
  })

  it('materializes only the legacy suffix needed to place a project before a group', () => {
    const updates = getRootProjectOrderUpdatesForSidebarDrop({
      projectGroups: [group('a'), group('b', { tabOrder: 1 })],
      repos: [repo('x'), repo('y')],
      visibleKeys: ['group:a', 'group:b', 'repo:x', 'repo:y'],
      draggedKey: 'repo:y',
      dropIndex: 1
    })
    expect(updates).toMatchObject([
      { entry: { kind: 'repo', repo: { id: 'y' } }, rootProjectOrder: -2000 },
      { entry: { kind: 'group', group: { id: 'b' } }, rootProjectOrder: -1000 }
    ])
  })

  it('keeps group order synchronized when the recent view exposes only group headers', () => {
    const updates = getRootProjectOrderUpdatesForSidebarDrop({
      projectGroups: [
        group('a', { rootProjectOrder: 0 }),
        group('b', { rootProjectOrder: 2000, tabOrder: 1 })
      ],
      repos: [repo('x', { projectGroupOrder: 1000 })],
      visibleKeys: ['group:a', 'group:b'],
      draggedKey: 'group:b',
      dropIndex: 0
    })
    expect(updates).toMatchObject([
      { entry: { kind: 'group', group: { id: 'b' } }, rootProjectOrder: -1000, tabOrder: -1000 }
    ])
  })

  it('does not sweep legacy groups from another host section when reordering root entries on one host', () => {
    const updates = getRootProjectOrderUpdatesForSidebarDrop({
      projectGroups: [
        group('local-a', { executionHostId: 'local' }),
        group('remote-b', { executionHostId: 'runtime:remote', tabOrder: 1 })
      ],
      repos: [repo('local-x', { executionHostId: 'local', projectGroupOrder: 0 })],
      visibleKeys: ['group:local-a', 'repo:local-x'],
      draggedKey: 'repo:local-x',
      dropIndex: 0
    })

    expect(updates).toHaveLength(2)
    expect(updates).toMatchObject([
      { entry: { kind: 'repo', repo: { id: 'local-x' } }, rootProjectOrder: 0 },
      { entry: { kind: 'group', group: { id: 'local-a' } }, rootProjectOrder: 1000 }
    ])
  })
  it('uses the actual host occurrence when repeated logical headers span sections', () => {
    const host = (hostId: HostHeaderRow['hostId']): HostHeaderRow => ({
      type: 'host-header',
      key: hostId,
      hostId,
      kind: hostId === 'local' ? 'local' : 'runtime',
      label: hostId,
      detail: '',
      health: 'available',
      collapsed: false,
      count: 1
    })
    const rows: HostSectionRow[] = [
      host('local'),
      {
        type: 'header',
        key: 'group:a',
        count: 1,
        icon: { kind: 'project' },
        projectGroup: group('a'),
        hostId: 'local'
      },
      {
        type: 'header',
        key: 'repo:x',
        count: 1,
        icon: { kind: 'project' },
        repo: repo('x'),
        hostId: 'local'
      },
      host('runtime:remote'),
      {
        type: 'header',
        key: 'group:a',
        count: 1,
        icon: { kind: 'project' },
        projectGroup: group('a'),
        hostId: 'runtime:remote',
        repeated: true
      },
      {
        type: 'header',
        key: 'repo:remote-x',
        count: 1,
        icon: { kind: 'project' },
        repo: repo('remote-x', { executionHostId: 'runtime:remote' }),
        anchorRepo: repo('x'),
        hostId: 'runtime:remote',
        repeated: true
      },
      {
        type: 'header',
        key: 'repo:y',
        count: 1,
        icon: { kind: 'project' },
        repo: repo('y'),
        hostId: 'runtime:remote'
      }
    ]
    const keys = getSidebarRootProjectHeaderKeys(rows)
    expect(keys).toEqual([
      'host:local',
      'group:a',
      'repo:x',
      'host:runtime:remote',
      'group:a',
      'repo:x',
      'repo:y'
    ])
    expect(getRootProjectHeaderDragKeys(keys, 'group:a', 'runtime:remote')).toEqual([
      'group:a',
      'repo:x',
      'repo:y'
    ])
    expect(getRootProjectHeaderDragKeys(keys, 'repo:y', 'local')).toBeUndefined()
    expect([...getRootProjectHeaderCountByOccurrenceKey(keys)]).toEqual([
      ['["local","group:a"]', 2],
      ['["local","repo:x"]', 2],
      ['["runtime:remote","group:a"]', 3],
      ['["runtime:remote","repo:x"]', 3],
      ['["runtime:remote","repo:y"]', 3]
    ])

    const container = document.createElement('div')
    for (const [hostId, key] of [
      ['local', 'group:a'],
      ['local', 'repo:x'],
      ['runtime:remote', 'group:a'],
      ['runtime:remote', 'repo:y']
    ]) {
      const element = document.createElement('div')
      element.dataset.rootProjectHeaderKey = key
      element.dataset.rootProjectHeaderHost = hostId
      container.append(element)
    }
    expect(
      measureRootProjectHeaderDragRects(container, ['group:a', 'repo:y'], 'runtime:remote').map(
        (rect) => rect.key
      )
    ).toEqual(['group:a', 'repo:y'])
  })

  it('respaces root ranks when ungrouping a project exhausts midpoint, tail, or head float precision', async () => {
    const parent = group('g-src', { tabOrder: 0, rootProjectOrder: 0 })
    const runUngroupCase = async (args: {
      rootRepos: Repo[]
      dragged: Repo
      dropIndex: number
    }): Promise<{ key: string; order: number | undefined }[]> => {
      const repos = [...args.rootRepos.map((entry) => ({ ...entry })), { ...args.dragged }]
      let updates: ReturnType<typeof getRootProjectOrderUpdatesForSidebarDrop> = []
      await commitProjectHeaderDragDrop({
        session: {
          repo: args.dragged,
          groupRepo: args.dragged,
          bucketKey: 'group:g-src',
          sidebarRepoHeaderIds: [args.dragged.id],
          rootProjectHeaderKeys: args.rootRepos.map((entry) => `repo:${entry.id}`)
        },
        dropTarget: {
          kind: 'slot',
          targetBucketKey: 'root-interleaved',
          dropIndex: args.dropIndex,
          dropIndicatorY: 40
        },
        sidebarRepoHeaderIdsByBucket: new Map([['group:g-src', [args.dragged.id]]]),
        projectGroups: [parent],
        projectGroupById: new Map([['g-src', parent]]),
        orderedRepoIds: repos.map((entry) => entry.id),
        repoById: new Map(repos.map((entry) => [entry.id, entry])),
        liveRepos: repos,
        usesProjectGroupOrdering: true,
        onCommitRepoOrder: vi.fn(),
        onCommitProjectGroupOrder: async (target, groupId, order) => {
          const match = repos.find((entry) => entry.id === target.id)
          if (match) {
            match.projectGroupId = groupId
            match.projectGroupOrder = order
          }
          return true
        },
        onCommitRootProjectOrder: (visibleKeys, draggedKey, dropIndex) => {
          updates = getRootProjectOrderUpdatesForSidebarDrop({
            repos,
            projectGroups: [],
            visibleKeys,
            draggedKey,
            dropIndex
          })
        },
        onMoveToGroupHeader: vi.fn()
      })
      return updates.map((entry) => ({
        key:
          entry.entry.kind === 'group'
            ? `group:${entry.entry.group.id}`
            : `repo:${entry.entry.repo.id}`,
        order: entry.rootProjectOrder
      }))
    }

    await expect(
      runUngroupCase({
        rootRepos: [
          repo('r-eps-a', { projectGroupOrder: 1 }),
          repo('r-eps-b', { projectGroupOrder: 1 + Number.EPSILON })
        ],
        dragged: repo('r-mid', { projectGroupId: 'g-src', projectGroupOrder: 0 }),
        dropIndex: 1
      })
    ).resolves.toEqual([
      { key: 'repo:r-eps-a', order: 0 },
      { key: 'repo:r-mid', order: 1000 },
      { key: 'repo:r-eps-b', order: 2000 }
    ])

    await expect(
      runUngroupCase({
        rootRepos: [repo('r-huge-tail', { projectGroupOrder: 2 ** 64 })],
        dragged: repo('r-tail', { projectGroupId: 'g-src', projectGroupOrder: 0 }),
        dropIndex: 1
      })
    ).resolves.toEqual([
      { key: 'repo:r-huge-tail', order: 0 },
      { key: 'repo:r-tail', order: 1000 }
    ])

    await expect(
      runUngroupCase({
        rootRepos: [repo('r-huge-head', { projectGroupOrder: -(2 ** 64) })],
        dragged: repo('r-head', { projectGroupId: 'g-src', projectGroupOrder: 0 }),
        dropIndex: 0
      })
    ).resolves.toEqual([
      { key: 'repo:r-head', order: 0 },
      { key: 'repo:r-huge-head', order: 1000 }
    ])
  })
})
