import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import { repo, worktree } from './worktree-list-groups-test-fixtures'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

describe('buildRows project grouping order', () => {
  const repoA: Repo = { ...repo, id: 'repo-a', displayName: 'alpha' }
  const repoB: Repo = { ...repo, id: 'repo-b', displayName: 'beta' }
  const repoC: Repo = { ...repo, id: 'repo-c', displayName: 'gamma' }
  const map = new Map([
    [repoA.id, repoA],
    [repoB.id, repoB],
    [repoC.id, repoC]
  ])
  // Activity: C (300) is freshest, then A (200), then B (100). wAStale (50) is
  // an older sibling of A so a repo's rank is its max child, not its first.
  const wA: Worktree = {
    ...worktree,
    id: 'wt-a',
    repoId: repoA.id,
    displayName: 'a',
    lastActivityAt: 200
  }
  const wAStale: Worktree = {
    ...worktree,
    id: 'wt-a-stale',
    repoId: repoA.id,
    displayName: 'a2',
    lastActivityAt: 50
  }
  const wB: Worktree = {
    ...worktree,
    id: 'wt-b',
    repoId: repoB.id,
    displayName: 'b',
    lastActivityAt: 100
  }
  const wC: Worktree = {
    ...worktree,
    id: 'wt-c',
    repoId: repoC.id,
    displayName: 'c',
    lastActivityAt: 300
  }

  it('orders repo headers by explicit repoOrder, not first-encounter', () => {
    // Worktree stream encounters in order C, A, B — but repoOrder says B, A, C.
    const repoOrder = new Map([
      [repoB.id, 0],
      [repoA.id, 1],
      [repoC.id, 2]
    ])
    const rows = buildRows('repo', [wC, wA, wB], map, null, new Set(), repoOrder)
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-b', 'repo:repo-a', 'repo:repo-c'])
  })

  it('places unknown repo ids last and sorts them by label', () => {
    // Only repoB is in repoOrder; repoA and repoC fall through to label sort.
    const repoOrder = new Map([[repoB.id, 0]])
    const rows = buildRows('repo', [wC, wA, wB], map, null, new Set(), repoOrder)
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-b', 'repo:repo-a', 'repo:repo-c'])
  })

  it('orders repo headers by max(lastActivityAt) per repo in Recent mode', () => {
    // repoOrder pins B, A, C, but Recent ignores it: C (300) > A (200) > B (100).
    // The incoming array is name-sorted (not pre-sorted by recency), proving the
    // resolver computes the timestamp itself rather than trusting encounter order.
    const repoOrder = new Map([
      [repoB.id, 0],
      [repoA.id, 1],
      [repoC.id, 2]
    ])
    const rows = buildRows(
      'repo',
      [wA, wB, wC],
      map,
      null,
      new Set(),
      repoOrder,
      undefined,
      'recent'
    )
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-c', 'repo:repo-a', 'repo:repo-b'])
  })

  it("uses each repo's freshest visible child, not its first, in Recent mode", () => {
    // repo-a has a fresh child (200) and a stale one (50); its rank is the max.
    const rows = buildRows(
      'repo',
      [wAStale, wA, wB, wC],
      map,
      null,
      new Set(),
      undefined,
      undefined,
      'recent'
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-c' },
      { type: 'item', worktree: { id: 'wt-c' } },
      { type: 'header', key: 'repo:repo-a' },
      // Child rows keep their input order; only the header rank uses max activity.
      { type: 'item', worktree: { id: 'wt-a-stale' } },
      { type: 'item', worktree: { id: 'wt-a' } },
      { type: 'header', key: 'repo:repo-b' },
      { type: 'item', worktree: { id: 'wt-b' } }
    ])
  })

  it('keeps the main workspace first inside its project group in Recent mode', () => {
    const main = {
      ...wA,
      id: 'wt-a-main',
      displayName: 'main',
      isMainWorktree: true,
      lastActivityAt: 10
    }
    const freshChild = {
      ...wA,
      id: 'wt-a-fresh-child',
      displayName: 'fresh-child',
      isMainWorktree: false,
      lastActivityAt: 500
    }
    const rows = buildRows(
      'repo',
      [freshChild, wB, main],
      map,
      null,
      new Set(),
      undefined,
      undefined,
      'recent'
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-a' },
      { type: 'item', worktree: { id: 'wt-a-main' } },
      { type: 'item', worktree: { id: 'wt-a-fresh-child' } },
      { type: 'header', key: 'repo:repo-b' },
      { type: 'item', worktree: { id: 'wt-b' } }
    ])
  })

  it('orders repo headers by repoOrder in Manual mode (default), ignoring activity', () => {
    const repoOrder = new Map([
      [repoB.id, 0],
      [repoA.id, 1],
      [repoC.id, 2]
    ])
    const rows = buildRows('repo', [wC, wA, wB], map, null, new Set(), repoOrder)
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-b', 'repo:repo-a', 'repo:repo-c'])
  })

  it('builds rows for a very large repo-group list', () => {
    const count = 130_000
    const repos = new Map<string, Repo>()
    const worktrees = Array.from({ length: count }, (_, index) => {
      const repoId = `repo-${index}`
      repos.set(repoId, { ...repo, id: repoId, displayName: `repo ${index}` })
      return { ...worktree, id: `wt-${index}`, repoId, displayName: `workspace ${index}` }
    })

    const rows = buildRows('repo', worktrees, repos, null, new Set())

    expect(rows).toHaveLength(count * 2)
    expect(rows[0]).toMatchObject({ type: 'header', key: 'repo:repo-0' })
    expect(rows.at(-1)).toMatchObject({ type: 'item', worktree: { id: 'wt-129999' } })
  })
})

describe('buildRows Recent project order fallbacks', () => {
  const active: Repo = { ...repo, id: 'repo-active', displayName: 'active', addedAt: 0 }
  // Empty project has no visible worktrees, so Recent falls back to addedAt.
  const empty: Repo = { ...repo, id: 'repo-empty', displayName: 'empty', addedAt: 999 }
  const map = new Map([
    [active.id, active],
    [empty.id, empty]
  ])
  const activeWorktree: Worktree = {
    ...worktree,
    id: 'wt-active',
    repoId: active.id,
    displayName: 'active',
    lastActivityAt: 100
  }

  it('sorts placeholder projects after projects with activity', () => {
    // empty.addedAt (999) is numerically higher than active's worktree (100),
    // but a real activity timestamp must always outrank an addedAt fallback.
    const rows = buildRows(
      'repo',
      [activeWorktree],
      map,
      null,
      new Set(),
      undefined,
      undefined,
      'recent',
      {},
      undefined,
      false,
      undefined,
      [],
      new Set([empty.id])
    )
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-active', 'repo:repo-empty'])
  })
})

describe('project groups', () => {
  it('orders repos inside a Project Group by projectGroupOrder in manual mode', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const repoA: Repo = {
      ...repo,
      id: 'repo-a',
      displayName: 'alpha',
      projectGroupId: group.id,
      projectGroupOrder: 1
    }
    const repoB: Repo = {
      ...repo,
      id: 'repo-b',
      displayName: 'beta',
      projectGroupId: group.id,
      projectGroupOrder: 0
    }
    const worktreeA: Worktree = { ...worktree, id: 'wt-a', repoId: repoA.id }
    const worktreeB: Worktree = { ...worktree, id: 'wt-b', repoId: repoB.id }
    const groupedMap = new Map([
      [repoA.id, repoA],
      [repoB.id, repoB]
    ])
    const repoOrder = new Map([
      [repoA.id, 0],
      [repoB.id, 1]
    ])

    const rows = buildRows(
      'repo',
      [worktreeA, worktreeB],
      groupedMap,
      null,
      new Set(),
      repoOrder,
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1',
      'repo:repo-b',
      'repo:repo-a'
    ])
  })

  it('falls back to repoOrder for grouped repos missing projectGroupOrder in manual mode', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const repoA: Repo = { ...repo, id: 'repo-a', displayName: 'alpha', projectGroupId: group.id }
    const repoB: Repo = { ...repo, id: 'repo-b', displayName: 'beta', projectGroupId: group.id }
    const repoC: Repo = { ...repo, id: 'repo-c', displayName: 'gamma', projectGroupId: group.id }
    const groupedMap = new Map([
      [repoA.id, repoA],
      [repoB.id, repoB],
      [repoC.id, repoC]
    ])
    const repoOrder = new Map([
      [repoA.id, 0],
      [repoB.id, 1],
      [repoC.id, 2]
    ])

    const rows = buildRows(
      'repo',
      [
        { ...worktree, id: 'wt-a', repoId: repoA.id },
        { ...worktree, id: 'wt-b', repoId: repoB.id },
        { ...worktree, id: 'wt-c', repoId: repoC.id }
      ],
      groupedMap,
      null,
      new Set(),
      repoOrder,
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1',
      'repo:repo-a',
      'repo:repo-b',
      'repo:repo-c'
    ])
  })

  it('sorts a dragged project between repo-order fallbacks inside a group', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const repoA: Repo = { ...repo, id: 'repo-a', displayName: 'alpha', projectGroupId: group.id }
    const repoB: Repo = { ...repo, id: 'repo-b', displayName: 'beta', projectGroupId: group.id }
    const repoC: Repo = {
      ...repo,
      id: 'repo-c',
      displayName: 'gamma',
      projectGroupId: group.id,
      projectGroupOrder: 500
    }
    const groupedMap = new Map([
      [repoA.id, repoA],
      [repoB.id, repoB],
      [repoC.id, repoC]
    ])
    const repoOrder = new Map([
      [repoA.id, 0],
      [repoB.id, 1],
      [repoC.id, 2]
    ])

    const rows = buildRows(
      'repo',
      [
        { ...worktree, id: 'wt-a', repoId: repoA.id },
        { ...worktree, id: 'wt-b', repoId: repoB.id },
        { ...worktree, id: 'wt-c', repoId: repoC.id }
      ],
      groupedMap,
      null,
      new Set(),
      repoOrder,
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1',
      'repo:repo-a',
      'repo:repo-c',
      'repo:repo-b'
    ])
  })

  it('orders repos inside a Project Group by activity in recent mode, keeping tabOrder', () => {
    const groupA: ProjectGroup = {
      id: 'group-a',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 1,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const groupB: ProjectGroup = { ...groupA, id: 'group-b', name: 'Infra', tabOrder: 0 }
    // Inside group A: repoStale ordered first by projectGroupOrder, but repoFresh
    // is more recently active so recent mode must lift it above repoStale.
    const repoStale: Repo = {
      ...repo,
      id: 'repo-stale',
      displayName: 'stale',
      projectGroupId: groupA.id,
      projectGroupOrder: 0
    }
    const repoFresh: Repo = {
      ...repo,
      id: 'repo-fresh',
      displayName: 'fresh',
      projectGroupId: groupA.id,
      projectGroupOrder: 1
    }
    const groupedMap = new Map([
      [repoStale.id, repoStale],
      [repoFresh.id, repoFresh]
    ])
    const worktrees = [
      { ...worktree, id: 'wt-stale', repoId: repoStale.id, lastActivityAt: 10 },
      { ...worktree, id: 'wt-fresh', repoId: repoFresh.id, lastActivityAt: 500 }
    ]

    const rows = buildRows(
      'repo',
      worktrees,
      groupedMap,
      null,
      new Set(),
      undefined,
      undefined,
      'recent',
      {},
      new Map(worktrees.map((entry) => [entry.id, entry])),
      false,
      undefined,
      // Group headers always follow tabOrder (Infra=0 before Platform=1),
      // independent of projectOrderBy.
      [groupA, groupB]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-b',
      'project-group:group-a',
      'repo:repo-fresh',
      'repo:repo-stale'
    ])
  })

  it('orders Project Group siblings by tabOrder within each parent bucket', () => {
    const rootA: ProjectGroup = {
      id: 'group-root-a',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 20,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const rootB: ProjectGroup = {
      ...rootA,
      id: 'group-root-b',
      name: 'Infrastructure',
      tabOrder: 10
    }
    const childLate: ProjectGroup = {
      ...rootA,
      id: 'group-child-late',
      name: 'late',
      parentGroupId: rootB.id,
      tabOrder: 30
    }
    const childEarly: ProjectGroup = {
      ...rootA,
      id: 'group-child-early',
      name: 'early',
      parentGroupId: rootB.id,
      tabOrder: 5
    }

    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      'recent',
      {},
      undefined,
      false,
      undefined,
      [rootA, rootB, childLate, childEarly]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-root-b',
      'project-group:group-child-early',
      'project-group:group-child-late',
      'project-group:group-root-a'
    ])
    expect(rows.filter((row) => row.type === 'header').map((row) => row.projectGroupDepth)).toEqual(
      [0, 1, 1, 0]
    )
  })
})
