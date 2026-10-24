import { projectWorktreeLineageWithHostPeers } from '../main/worktree-lineage-host-peers'
import { buildRuntimeWorktreePsSummaries } from '../main/runtime/runtime-worktree-ps-summaries'
import {
  normalizePairedServerRow,
  PairedServerRowsSnapshotSchema
} from './sidebar-list/paired-server-rows'
import { readFeedPairedServerRow } from './sidebar-list/sidebar-feed-worktrees'
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { WorktreeLineage } from './worktree/lineage-types'
import type { Worktree } from './worktree/types'
import type { LineageRow, WorktreeLineageBoundary } from './resolved-worktree-lineage'
import {
  projectResolvedWorktreeLineage,
  resolveWorktreeLineageParents,
  sharesWorktreeLineageBoundary
} from './resolved-worktree-lineage'

function worktree(id: string, instanceId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    instanceId,
    repoId: 'repo',
    path: join('workspace', id),
    head: 'abc123',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function lineage(overrides: Partial<WorktreeLineage> = {}): WorktreeLineage {
  return {
    worktreeId: 'child',
    worktreeInstanceId: 'child-instance',
    parentWorktreeId: 'parent',
    parentWorktreeInstanceId: 'parent-instance',
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1,
    ...overrides
  }
}

function publish(
  worktrees: readonly Worktree[],
  edges: Readonly<Record<string, WorktreeLineage>>,
  knownPeers: readonly Worktree[] = []
) {
  return projectWorktreeLineageWithHostPeers(
    {
      getAllWorktreeLineage: () => edges,
      getRepos: () => [],
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    },
    { id: 'repo', path: 'workspace', displayName: 'repo', badgeColor: 'blue', addedAt: 1 },
    [...worktrees, ...knownPeers]
  )
}

describe('sharesWorktreeLineageBoundary', () => {
  const boundary = (overrides: Partial<WorktreeLineageBoundary> = {}): WorktreeLineageBoundary => ({
    hostId: 'local',
    ...overrides
  })

  it('accepts the same host', () => {
    expect(sharesWorktreeLineageBoundary(boundary(), boundary())).toBe(true)
  })

  it.each([
    ['child host', boundary({ hostId: undefined }), boundary()],
    ['parent host', boundary(), boundary({ hostId: undefined })]
  ])('treats an undefined %s as compatible', (_label, child, parent) => {
    expect(sharesWorktreeLineageBoundary(child, parent)).toBe(true)
  })

  it('accepts different hosts in one store', () => {
    expect(sharesWorktreeLineageBoundary(boundary(), boundary({ hostId: 'ssh:remote' }))).toBe(true)
  })
})

describe('projectResolvedWorktreeLineage', () => {
  it('keeps base publication exact while held readers resolve saved rename intent', () => {
    const edges = { child: lineage() }
    const c = worktree('child', 'child-instance', { hostId: 'local', savedLineage: edges.child })
    const p = worktree('renamed', 'parent-instance', { hostId: 'local' })
    expect(projectResolvedWorktreeLineage([c], edges, [p])[0].parentWorktreeId).toBe('renamed')
    expect(publish([c], edges, [p])[0]).toMatchObject({
      parentWorktreeId: null,
      savedLineage: edges.child
    })
    edges.child.parentWorktreeId = p.id
    expect(publish([c], edges, [p])[0].parentWorktreeId).toBe(p.id)
    expect(publish([c], edges, [{ ...p, hostId: 'ssh:other' }])[0].parentWorktreeId).toBeNull()
  })

  it('publishes the base indexed graph and saved intent without resolving external edges', () => {
    const childEdge = lineage()
    const parentEdge = lineage({
      worktreeId: 'parent',
      worktreeInstanceId: 'parent-instance',
      parentWorktreeId: 'peer',
      parentWorktreeInstanceId: 'peer-instance'
    })
    const peer = worktree('peer', 'peer-instance')
    const child = worktree('child', 'child-instance', { savedLineage: childEdge })
    const parent = worktree('parent', 'parent-instance', { savedLineage: null })
    const rows = publish(
      [child, parent],
      {
        child: childEdge,
        parent: parentEdge,
        peer: lineage({ worktreeId: peer.id, worktreeInstanceId: peer.instanceId! })
      },
      [peer]
    )
    expect(rows).toMatchObject([
      { parentWorktreeId: 'parent', childWorktreeIds: [], lineage: childEdge },
      {
        parentWorktreeId: null,
        childWorktreeIds: ['child'],
        lineage: null,
        savedLineage: parentEdge
      },
      { parentWorktreeId: null, childWorktreeIds: [], lineage: null }
    ])
    expect(rows[0].savedLineage).toBe(childEdge)
    const external = { ...childEdge, parentStore: 'external' as const }
    expect(
      publish([{ ...child, savedLineage: external }], { child: external }, [parent])[0]
    ).toMatchObject({ parentWorktreeId: null, lineage: null, savedLineage: external })
  })
  const parent = worktree('parent', 'parent-instance')
  const child = worktree('child', 'child-instance')

  it('projects exact instance-aware metadata across projects on one host', () => {
    const foreignParent = {
      ...parent,
      repoId: 'other',
      projectId: 'parent',
      hostId: 'local' as const
    }
    const ownedChild = { ...child, projectId: 'child', hostId: 'local' as const }
    const projected = projectResolvedWorktreeLineage([ownedChild, foreignParent], {
      child: lineage()
    })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: 'parent', childWorktreeIds: [], lineage: lineage() },
      { id: 'parent', parentWorktreeId: null, childWorktreeIds: ['child'], lineage: null }
    ])
  })

  it.each([
    ['stale child instance', lineage({ worktreeInstanceId: 'old-child' })],
    ['stale parent instance', lineage({ parentWorktreeInstanceId: 'old-parent' })],
    ['mismatched child record', lineage({ worktreeId: 'other-child' })]
  ])('rejects %s', (_label, candidate) => {
    const projected = projectResolvedWorktreeLineage([child, parent], { child: candidate })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: null, lineage: null },
      { id: 'parent', childWorktreeIds: [] }
    ])
  })

  it('resolves across execution hosts in the same store', () => {
    const childOverrides = { hostId: 'local' as const }
    const parentOverrides = { hostId: 'ssh:remote' as const }
    const boundedChild = worktree('child', 'child-instance', childOverrides)
    const boundedParent = worktree('parent', 'parent-instance', parentOverrides)

    const projected = projectResolvedWorktreeLineage([boundedChild, boundedParent], {
      child: lineage()
    })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: 'parent', lineage: lineage() },
      { id: 'parent', childWorktreeIds: ['child'] }
    ])
  })

  it('leaves identical copied locators ambiguous within a store', () => {
    const localParent = worktree('parent', 'parent-instance', { hostId: 'local' })
    const remoteParent = worktree('parent', 'parent-instance', { hostId: 'ssh:remote' })
    const localChild = worktree('child', 'child-instance', { hostId: 'local' })
    expect(
      projectResolvedWorktreeLineage([localChild, remoteParent, localParent], {
        child: lineage()
      })
    ).toMatchObject([
      { parentWorktreeId: null },
      { childWorktreeIds: [] },
      { childWorktreeIds: [] }
    ])
  })

  it('accepts legacy records when only one side has host or project identity', () => {
    const legacyChild = worktree('child', 'child-instance', {
      hostId: 'local',
      projectId: 'github:stablyai/orca'
    })

    const projected = projectResolvedWorktreeLineage([legacyChild, parent], {
      child: lineage()
    })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: 'parent', lineage: lineage() },
      { id: 'parent', childWorktreeIds: ['child'] }
    ])
  })

  it('rejects self-parent lineage', () => {
    const projected = projectResolvedWorktreeLineage([child], {
      child: lineage({
        parentWorktreeId: child.id,
        parentWorktreeInstanceId: child.instanceId!
      })
    })

    expect(projected[0]).toMatchObject({
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    })
  })

  it('rejects every edge in a multi-node cycle without hiding valid descendants', () => {
    const grandchild = worktree('grandchild', 'grandchild-instance')
    const parentToChild = lineage({
      worktreeId: parent.id,
      worktreeInstanceId: parent.instanceId!,
      parentWorktreeId: child.id,
      parentWorktreeInstanceId: child.instanceId!
    })
    const grandchildToParent = lineage({
      worktreeId: grandchild.id,
      worktreeInstanceId: grandchild.instanceId!
    })

    const projected = projectResolvedWorktreeLineage([child, parent, grandchild], {
      child: lineage(),
      parent: parentToChild,
      grandchild: grandchildToParent
    })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: null, childWorktreeIds: [], lineage: null },
      {
        id: 'parent',
        parentWorktreeId: null,
        childWorktreeIds: ['grandchild'],
        lineage: null
      },
      { id: 'grandchild', parentWorktreeId: 'parent', lineage: grandchildToParent }
    ])
  })

  it('rejects a missing parent without mutating the raw lineage record', () => {
    const rawLineage = lineage()
    const projected = projectResolvedWorktreeLineage([child], { child: rawLineage })

    expect(projected[0]).toMatchObject({ parentWorktreeId: null, lineage: null })
    expect(rawLineage.parentWorktreeId).toBe('parent')
  })

  it('replaces disagreeing parent and child projections from the validated lineage record', () => {
    const projected = projectResolvedWorktreeLineage(
      [
        { ...child, parentWorktreeId: 'stale-parent', childWorktreeIds: ['stale-child'] },
        { ...parent, parentWorktreeId: 'stale-parent', childWorktreeIds: [] }
      ] as (Worktree & { parentWorktreeId: string; childWorktreeIds: string[] })[],
      { child: lineage() }
    )

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: 'parent', childWorktreeIds: [] },
      { id: 'parent', parentWorktreeId: null, childWorktreeIds: ['child'] }
    ])
  })
})

describe('cross-store lineage contract', () => {
  it('uses exact locators, unique rename identities, explicit external links, and removes cycles', () => {
    const parent = { id: 'parent', instanceId: 'p', hostId: 'ssh:a' as const }
    const copy = { id: 'copied', instanceId: 'p', hostId: 'local' as const }
    const child = { id: 'child', instanceId: 'c', hostId: 'local' as const }
    const remote = { id: 'renamed', instanceId: 'p', hostId: 'runtime:server' as const }
    const edge = {
      parentWorktreeId: 'parent',
      parentWorktreeInstanceId: 'p',
      worktreeInstanceId: 'c'
    }
    const external = { ...edge, parentWorktreeInstanceId: 'p', parentStore: 'external' as const }
    const cases = [
      { rows: [child, parent, copy], edge, parent },
      { rows: [child, copy], edge, parent: copy },
      {
        rows: [child, { ...parent, id: 'copy-a' }, remote, { ...parent, id: 'copy-b' }],
        edge: { ...external, parentWorktreeId: 'missing' },
        parent: remote
      },
      { rows: [child, remote], edge: external, parent: remote },
      { rows: [child, remote], edge: { ...external, parentStore: undefined }, parent: undefined },
      {
        rows: [child, remote, { ...remote, hostId: 'runtime:other' as const }],
        edge: external,
        parent: undefined
      },
      { rows: [child, parent], edge: { parentWorktreeId: 'parent' }, parent: undefined }
    ]
    for (const item of cases) {
      const parents = resolveWorktreeLineageParents<LineageRow>(item.rows, (row) =>
        row === child ? item.edge : null
      )
      expect(parents.get(child)).toBe(item.parent)
    }
    expect(
      resolveWorktreeLineageParents([child, parent], (row) =>
        row === child ? edge : { parentWorktreeId: 'child', parentWorktreeInstanceId: 'c' }
      ).size
    ).toBe(0)
  })

  it('keeps an unresolved saved server edge through the actual server publication and desktop adapters', () => {
    const edge = lineage({ parentStore: 'external' })
    const parent = worktree('parent', 'parent-instance', { hostId: 'local' })
    const child = worktree('child', 'child-instance', { hostId: 'local' })
    const projected = projectResolvedWorktreeLineage([child], { child: edge })[0]
    const summaries = buildRuntimeWorktreePsSummaries({
      store: null,
      resolvedWorktrees: [{ ...projected, git: child }],
      platformByRepoId: new Map()
    })
    const twin = { ...parent, hostId: 'ssh:copy' as const, isArchived: true }
    const complete = projectResolvedWorktreeLineage(
      [parent, twin, { ...child, savedLineage: lineage() }],
      {}
    )
    const ambiguous = buildRuntimeWorktreePsSummaries({
      store: null,
      resolvedWorktrees: complete.map((row) => ({ ...row, git: row })),
      platformByRepoId: new Map()
    })
    expect(ambiguous.get('child')?.parentWorktreeId).toBeNull()
    const summary = summaries.get('child')!
    expect(summary.parentWorktreeId).toBeNull()
    expect(summary.savedLineage).toEqual(edge)
    const row = normalizePairedServerRow('runtime:server', summary)!
    const snapshot = PairedServerRowsSnapshotSchema.parse({
      revision: 1,
      servers: [{ hostId: 'runtime:server', freshness: 'live', host: null, rows: [row] }]
    })
    const desktop = readFeedPairedServerRow(snapshot.servers[0].rows[0])!.worktree
    const parents = resolveWorktreeLineageParents([parent, desktop], (item) =>
      item.savedLineage !== undefined ? item.savedLineage : item.lineage
    )
    expect(parents.get(desktop)).toBe(parent)
  })
})
