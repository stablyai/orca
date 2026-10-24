import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { planSidebarRows } from '../../../../shared/sidebar-list/sidebar-row-plan'
import { repo, worktree } from './worktree-list-groups-test-fixtures'

const names = ['marea', 'jig', 'talkk-up', 'dockpin']
const repos: Repo[] = names.map((name) => ({
  ...repo,
  id: name,
  displayName: name,
  path: `/repos/${name}`
}))
const worktrees: Worktree[] = names.map((name) => ({
  ...worktree,
  id: `wt-${name}`,
  repoId: name,
  path: `/p/${name}`
}))

function projectHeaders(runningWorktreeIds: ReadonlySet<string>, runningProjectsFirst = true) {
  const plan = planSidebarRows({
    groupBy: 'repo',
    worktrees,
    repoMap: new Map(repos.map((value) => [value.id, value])),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: [],
    projectOrderBy: 'name',
    lineageById: {},
    worktreeMap: new Map(worktrees.map((value) => [value.id, value])),
    nestLineage: false,
    projectGroups: [],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: [],
    runningWorktreeIds,
    runningProjectsFirst
  })
  return plan
    .render(new Set())
    .flatMap((row) =>
      row.type === 'header'
        ? [
            `${row.runningSectionLabel ? `[${row.runningSectionLabel}] ` : ''}${row.label}${row.running ? ' (running)' : ''}`
          ]
        : []
    )
}

describe('active projects first', () => {
  it('lifts running projects above idle ones and labels both parts', () => {
    expect(projectHeaders(new Set(['wt-talkk-up', 'wt-marea']))).toEqual([
      '[active] marea (running)',
      'talkk-up (running)',
      '[idle] dockpin',
      'jig'
    ])
  })

  it('keeps the project order and flags running projects when switched off', () => {
    expect(projectHeaders(new Set(['wt-talkk-up']), false)).toEqual([
      'dockpin',
      'jig',
      'marea',
      'talkk-up (running)'
    ])
  })

  it('shows no labels when nothing is running', () => {
    expect(projectHeaders(new Set())).toEqual(['dockpin', 'jig', 'marea', 'talkk-up'])
  })
})
