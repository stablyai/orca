import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import { cloneDefaultWorkspaceStatuses } from '../workspace-statuses'
import { compileListArrangement } from '../workspace-lists/compile-list-arrangement'
import { listArrangementSchema } from '../workspace-lists/list-arrangement-schema'
import { buildArrangedGroups, getListSectionKey } from './arranged-groups'
import { planSidebarRows } from './sidebar-row-plan'

const repo: Repo = { id: 'r1', path: '/r', displayName: 'orca', badgeColor: '#000', addedAt: 0 }

function wt(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'r1',
    path: `/r/${id}`,
    head: 'abc',
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

const arrangement = {
  listId: 'plugin:acme.flow/flow',
  compiled: compileListArrangement(
    listArrangementSchema.parse({
      version: 1,
      facts: 1,
      sections: [
        {
          id: 'needs-you',
          title: 'Needs you',
          when: "activity.tier == 'needs-you' || ws.isUnread"
        },
        { id: 'working', title: 'Working', when: "activity.tier == 'working'" },
        { id: 'rest', title: 'Everything else' }
      ],
      sort: [{ by: 'ws.lastActivityAt', dir: 'desc' }]
    })
  )
}

const worktrees = [
  wt('a', { smartTier: 'working', lastActivityAt: 1 }),
  wt('b', { isUnread: true, lastActivityAt: 5 }),
  wt('c', { lastActivityAt: 9 }),
  wt('d', { smartTier: 'needs-you', lastActivityAt: 7 }),
  wt('e', { smartTier: 'working', lastActivityAt: 3 })
]

describe('arranged workspace list', () => {
  it('puts each workspace in its first matching section, sorted by the arrangement', () => {
    const groups = buildArrangedGroups({
      arrangement,
      naturalWorktrees: worktrees,
      repoOf: () => repo,
      prGroupOf: () => 'in-progress',
      folderWorkspaces: []
    })
    expect(groups.map(([key, group]) => [key, group.label, group.items.map((w) => w.id)])).toEqual([
      [getListSectionKey(arrangement.listId, 'needs-you'), 'Needs you', ['d', 'b']],
      [getListSectionKey(arrangement.listId, 'working'), 'Working', ['e', 'a']],
      [getListSectionKey(arrangement.listId, 'rest'), 'Everything else', ['c']]
    ])
  })

  it('draws plugin sections as headers and honours their collapse', () => {
    const plan = planSidebarRows({
      groupBy: 'repo',
      worktrees,
      repoMap: new Map([[repo.id, repo]]),
      prGroupOf: () => 'in-progress',
      workspaceStatuses: cloneDefaultWorkspaceStatuses(),
      projectOrderBy: 'manual',
      lineageById: {},
      worktreeMap: new Map(worktrees.map((w) => [w.id, w])),
      nestLineage: false,
      projectGroups: [],
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingCreations: [],
      folderWorkspaces: [],
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      pinnedDisplayPolicy: 'single-location',
      filterRepoIds: [],
      arrangement
    })
    const working = getListSectionKey(arrangement.listId, 'working')
    const rows = plan.render(new Set([working]))
    expect(
      rows.map((row) =>
        row.type === 'header'
          ? `# ${row.label} (${row.icon.kind})`
          : row.type === 'item'
            ? row.worktree.id
            : row.type
      )
    ).toEqual([
      '# Needs you (list-section)',
      'd',
      'b',
      '# Working (list-section)',
      '# Everything else (list-section)',
      'c'
    ])
  })

  it('keeps workspaces that need the person visible in a collapsed plugin section', () => {
    const plan = planSidebarRows({
      groupBy: 'none',
      worktrees,
      repoMap: new Map([[repo.id, repo]]),
      prGroupOf: () => 'in-progress',
      workspaceStatuses: cloneDefaultWorkspaceStatuses(),
      projectOrderBy: 'manual',
      lineageById: {},
      worktreeMap: new Map(worktrees.map((w) => [w.id, w])),
      nestLineage: false,
      projectGroups: [],
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingCreations: [],
      folderWorkspaces: [],
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      pinnedDisplayPolicy: 'single-location',
      filterRepoIds: [],
      arrangement
    })
    const rows = plan.render(new Set([getListSectionKey(arrangement.listId, 'needs-you')]))
    const ids = rows.flatMap((row) => (row.type === 'item' ? [row.worktree.id] : []))
    // d needs the person; b is only unread, so the collapse hides it.
    expect(ids).toContain('d')
    expect(ids).not.toContain('b')
  })

  it('arranges 300 workspaces well inside a frame', () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      wt(`w${i}`, {
        smartTier: (['working', 'needs-you', 'done', undefined] as const)[i % 4],
        lastActivityAt: (i * 7919) % 1000
      })
    )
    const run = () =>
      buildArrangedGroups({
        arrangement,
        naturalWorktrees: many,
        repoOf: () => repo,
        prGroupOf: () => 'in-progress',
        folderWorkspaces: []
      })
    run()
    const start = performance.now()
    for (let i = 0; i < 50; i++) {
      run()
    }
    expect((performance.now() - start) / 50).toBeLessThan(8)
  })
})
