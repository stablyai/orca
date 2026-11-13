import { describe, expect, it, vi } from 'vitest'
import { getFolderWorkspaceWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  getProjectedWorktreeLineageChildrenByParentId,
  resolveSidebarLineageParentIdentities
} from '../../../../shared/sidebar-list/worktree-lineage-projection'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'

import {
  getAttachedWorktreesForFolderWorkspace,
  getLineageChildrenByParentId
} from './folder-workspace-attached-worktrees'

function makeFolder(id = 'folder-1'): FolderWorkspace {
  return {
    id,
    projectGroupId: 'project-group-1',
    name: 'Folder',
    folderPath: '/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    path: `/worktrees/${overrides.id}`,
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    repoId: 'repo-1',
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeWorkspaceLineage(child: Worktree, folderId = 'folder-1'): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(child.id),
    childInstanceId: child.instanceId ?? null,
    parentWorkspaceKey: folderWorkspaceKey(folderId),
    parentInstanceId: null,
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' },
    createdAt: 1
  }
}

describe('getAttachedWorktreesForFolderWorkspace', () => {
  it('omits archived and stale-instance children', () => {
    const visible = makeWorktree({
      id: 'repo-1::/visible',
      instanceId: 'fresh'
    })
    const archived = makeWorktree({
      id: 'repo-1::/archived',
      isArchived: true
    })
    const stale = makeWorktree({ id: 'repo-1::/stale', instanceId: 'fresh' })

    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      workspaceLineageByChildKey: {
        [visible.id]: makeWorkspaceLineage(visible),
        [archived.id]: makeWorkspaceLineage(archived),
        [stale.id]: {
          ...makeWorkspaceLineage(stale),
          childInstanceId: 'stale'
        }
      },
      worktreeLineageById: {},
      worktreesByRepo: { 'repo-1': [visible, archived, stale] },
      crossStoreChildrenByFolderId: new Map()
    })

    expect(result.childWorktrees.map((worktree) => worktree.id)).toEqual([visible.id])
  })
})

function edge(child: Worktree, parent: Worktree, createdAt: number): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt
  }
}

it('keeps attachment order, descendants and Attached-tab parents on their resolved host and instance', () => {
  const root = makeWorktree({
    id: 'same-root',
    hostId: 'local',
    instanceId: 'local-root',
    lastActivityAt: 99
  })
  const twin = makeWorktree({ id: 'same-root', hostId: 'ssh:box', instanceId: 'remote-root' })
  const child = makeWorktree({ id: 'same-child', hostId: 'local', instanceId: 'local-child' })
  const remoteChild = makeWorktree({
    id: 'same-child',
    hostId: 'ssh:box',
    instanceId: 'remote-child'
  })
  const remoteGrandchild = makeWorktree({
    id: 'grandchild',
    hostId: 'ssh:box',
    instanceId: 'remote-grandchild'
  })
  const remoteOnly = makeWorktree({
    id: 'remote-only',
    hostId: 'ssh:box',
    instanceId: 'remote-only-instance'
  })
  const stale = makeWorktree({ id: 'stale', hostId: 'local', instanceId: 'new-instance' })
  const remoteEdge = edge(remoteChild, twin, 40)
  Object.assign(remoteChild, { lineage: remoteEdge })
  const result = getAttachedWorktreesForFolderWorkspace({
    activeWorkspaceKey: 'folder:folder-1',
    activeWorktreeId: null,
    executionHostId: 'local',
    folderWorkspaces: [makeFolder()],
    workspaceLineageByChildKey: {
      remoteOnly: { ...makeWorkspaceLineage(remoteOnly), createdAt: 60 },
      first: { ...makeWorkspaceLineage(twin), createdAt: 10 },
      second: { ...makeWorkspaceLineage(root), createdAt: 20 },
      stale: { ...makeWorkspaceLineage(stale), childInstanceId: 'old-instance' }
    },
    worktreeLineageById: {
      [child.id]: edge(child, root, 30),
      [remoteGrandchild.id]: edge(remoteGrandchild, remoteChild, 50)
    },
    worktreesByRepo: {
      remote: [twin, remoteChild, remoteGrandchild, remoteOnly],
      local: [root, child, stale]
    },
    crossStoreChildrenByFolderId: new Map()
  })
  expect(
    result.owners.map((owner) => [
      owner.executionHostId,
      owner.worktree.instanceId,
      owner.attachedAt
    ])
  ).toEqual([
    ['local', 'local-root', 20],
    ['local', 'local-child', 30],
    ['ssh:box', 'remote-only-instance', 60]
  ])
  expect(result.lineageChildrenByParentId.get('local|same-root')).toEqual([child])
  expect(result.lineageChildrenByParentId.has('ssh:box|same-root')).toBe(false)
  expect(result.rootChildWorktrees.map((row) => row.instanceId)).toEqual([
    'local-root',
    'remote-only-instance'
  ])
})

it('includes resolved cross-store roots and their descendants without attaching another host copy', () => {
  const root = makeWorktree({ id: 'remote-root', hostId: 'ssh:box', instanceId: 'root' })
  const twin = makeWorktree({ id: 'remote-root', hostId: 'ssh:other', instanceId: 'twin' })
  const child = makeWorktree({ id: 'remote-child', hostId: 'ssh:box', instanceId: 'child' })
  const lineage = edge(child, root, 5)
  Object.assign(child, { lineage })
  const result = getAttachedWorktreesForFolderWorkspace({
    activeWorkspaceKey: 'folder:folder-1',
    activeWorktreeId: null,
    executionHostId: 'local',
    folderWorkspaces: [makeFolder()],
    workspaceLineageByChildKey: {},
    worktreeLineageById: {},
    worktreesByRepo: { remote: [root, child], other: [twin] },
    lineageParentIdentities: new Map([
      ['ssh:box|remote-root', 'local|folder:folder-1'],
      ['ssh:box|remote-child', 'ssh:box|remote-root']
    ]),
    crossStoreChildrenByFolderId: new Map([['folder-1', [root]]])
  })
  expect(result.owners.map((owner) => owner.worktree.instanceId)).toEqual(['root', 'child'])
  expect(result.rootChildWorktrees).toEqual([root])
  expect(result.lineageChildrenByParentId.get('ssh:box|remote-root')).toEqual([child])
})

it('attaches cross-store roots only to the resolved host when folder IDs collide', () => {
  const localFolder = makeFolder()
  const pairedFolder: FolderWorkspace = { ...makeFolder(), executionHostId: 'runtime:paired' }
  const root = makeWorktree({ id: 'root', hostId: 'local', instanceId: 'root-instance' })
  const child = makeWorktree({ id: 'child', hostId: 'local', instanceId: 'child-instance' })
  const worktreeLineageById = { child: edge(child, root, 5) }
  const rows = [
    root,
    child,
    ...[localFolder, pairedFolder].map((folder) => getFolderWorkspaceWorktree(folder))
  ]
  const lineageParentIdentities = resolveSidebarLineageParentIdentities(
    worktreeLineageById,
    new Map(rows.map((row) => [getWorktreeHostIdentity(row), row])),
    new Map([
      [
        '',
        {
          installationId: 'local-installation',
          crossStoreLineageByChildKey: {
            [worktreeWorkspaceKey(root.id)]: {
              childWorkspaceKey: worktreeWorkspaceKey(root.id),
              childInstanceId: 'root-instance',
              parent: {
                installationId: 'paired-installation',
                workspaceKey: 'folder:folder-1',
                instanceId: 'folder-1'
              },
              origin: 'cli',
              capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
              createdAt: 1
            }
          }
        }
      ],
      ['paired', { installationId: 'paired-installation', crossStoreLineageByChildKey: {} }]
    ])
  )
  const inputs = {
    activeWorkspaceKey: 'folder:folder-1',
    activeWorktreeId: null,
    folderWorkspaces: [localFolder, pairedFolder],
    workspaceLineageByChildKey: {},
    worktreeLineageById,
    worktreesByRepo: { local: [root, child] },
    lineageParentIdentities,
    crossStoreChildrenByFolderId: new Map([['folder-1', [root]]])
  }

  const local = getAttachedWorktreesForFolderWorkspace({ ...inputs, executionHostId: 'local' })
  const paired = getAttachedWorktreesForFolderWorkspace({
    ...inputs,
    executionHostId: 'runtime:paired'
  })

  expect(local.childWorktrees).toEqual([])
  expect(paired.owners.map((owner) => owner.worktree.id)).toEqual(['root', 'child'])
})

it('retires an attached worktree at durable admission while legacy pending rows remain visible', () => {
  const child = makeWorktree({ id: 'repo-1::/retiring', removing: true })
  const list = (row: Worktree) =>
    getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      workspaceLineageByChildKey: { [row.id]: makeWorkspaceLineage(row) },
      worktreeLineageById: {},
      worktreesByRepo: { 'repo-1': [row] },
      crossStoreChildrenByFolderId: new Map()
    }).childWorktrees.map((row) => row.id)
  expect(list(child)).toEqual(['repo-1::/retiring'])
  expect(list({ ...child, removalRecorded: true })).toEqual([])
})

it.each([false, true])(
  'keeps live descendants through retired bridges, retired cross-store root=%s',
  (retiredRoot) => {
    const hostId = retiredRoot ? 'ssh:box' : 'local'
    const root = makeWorktree({
      id: 'root',
      hostId,
      instanceId: 'root',
      removing: retiredRoot ? true : undefined,
      removalRecorded: retiredRoot ? true : undefined
    })
    const bridge = makeWorktree({
      id: 'bridge',
      hostId,
      instanceId: 'bridge',
      removing: true,
      removalRecorded: true
    })
    const child = makeWorktree({ id: 'child', hostId, instanceId: 'child' })
    const leaf = makeWorktree({ id: 'leaf', hostId, instanceId: 'leaf' })
    const lineage = {
      bridge: edge(bridge, root, 2),
      child: edge(child, bridge, 3),
      leaf: edge(leaf, child, 4)
    }
    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      workspaceLineageByChildKey: retiredRoot ? {} : { root: makeWorkspaceLineage(root) },
      worktreeLineageById: lineage,
      worktreesByRepo: { 'repo-1': [root, bridge, child, leaf] },
      lineageParentIdentities: new Map([
        [getWorktreeHostIdentity(root), 'local|folder:folder-1'],
        [getWorktreeHostIdentity(bridge), getWorktreeHostIdentity(root)],
        [getWorktreeHostIdentity(child), getWorktreeHostIdentity(bridge)],
        [getWorktreeHostIdentity(leaf), getWorktreeHostIdentity(child)]
      ]),
      crossStoreChildrenByFolderId: new Map(retiredRoot ? [['folder-1', [root]]] : [])
    })
    expect(result.owners.map((owner) => owner.worktree.id)).toEqual(
      retiredRoot ? ['child', 'leaf'] : ['root', 'child', 'leaf']
    )
    expect(result.childWorktrees.map((row) => row.id).sort()).toEqual(
      retiredRoot ? ['child', 'leaf'] : ['child', 'leaf', 'root']
    )
    expect(result.rootChildWorktrees.map((row) => row.id).sort()).toEqual(
      retiredRoot ? ['child'] : ['child', 'root']
    )
    expect([...result.lineageChildrenByParentId]).toEqual([
      [getWorktreeHostIdentity(child), [leaf]]
    ])
  }
)

it('traverses retired chains with at most two visits per vertex and edge at N and 10N', () => {
  for (const size of [100, 1000]) {
    const nodes = Array.from({ length: size }, (_, index) =>
      makeWorktree({
        id: `node-${index}`,
        instanceId: `instance-${index}`,
        removing: index < size - 1 ? true : undefined,
        removalRecorded: index < size - 1 ? true : undefined
      })
    )
    const rows = new Map(nodes.map((row) => [row.id, row]))
    let catalogEnumerations = 0
    let catalogReads = 0
    const lineage = new Proxy(
      Object.fromEntries(
        nodes.slice(1).map((row, index) => [row.id, edge(row, nodes[index], index)])
      ),
      {
        ownKeys: (target) => {
          catalogEnumerations++
          return Reflect.ownKeys(target)
        },
        get: (target, key) => {
          catalogReads++
          return typeof key === 'string' ? target[key] : undefined
        }
      }
    )
    // The existing index is shared; count the two required reachability/emission passes over it.
    const adjacency = getProjectedWorktreeLineageChildrenByParentId(lineage, rows)
    let edgeVisits = 0
    for (const children of adjacency.values()) {
      for (let index = 0; index < children.length; index++) {
        const child = children[index]
        Object.defineProperty(children, index, {
          configurable: true,
          get: () => {
            edgeVisits++
            return child
          }
        })
      }
    }
    const vertexVisits = vi.spyOn(adjacency, 'get')
    const rowValues = vi.spyOn(rows, 'values')
    const rowIterator = vi.spyOn(rows, Symbol.iterator)
    const rowReads = vi.spyOn(rows, 'get')
    catalogEnumerations = 0
    catalogReads = 0
    try {
      const result = getLineageChildrenByParentId(lineage, rows, new Set([nodes[0].id]))
      expect([...result.values()].flat().map((row) => row.id)).toEqual([`node-${size - 1}`])
      expect(vertexVisits.mock.calls.length).toBeGreaterThanOrEqual(size)
      expect(vertexVisits.mock.calls.length).toBeLessThanOrEqual(2 * size)
      expect(edgeVisits).toBeGreaterThanOrEqual(size - 1)
      expect(edgeVisits).toBeLessThanOrEqual(2 * (size - 1))
      expect(catalogEnumerations).toBe(0)
      expect(catalogReads).toBe(0)
      expect(rowValues).not.toHaveBeenCalled()
      expect(rowIterator).not.toHaveBeenCalled()
      expect(rowReads.mock.calls.length).toBeLessThanOrEqual(size)
    } finally {
      vertexVisits.mockRestore()
      rowValues.mockRestore()
      rowIterator.mockRestore()
      rowReads.mockRestore()
    }
  }
})
