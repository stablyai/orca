import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  addHostSectionRows,
  type HostSectionRow
} from '../../../../../../shared/sidebar-list/host-section-rows'
import { getProjectGroupHeaderKey } from '../../../../../../shared/sidebar-list/group-keys'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { buildRows } from './build-rows.test-fixture'

const HOST_OPTIONS = [
  {
    id: 'local',
    kind: 'local',
    label: 'Local Mac',
    detail: 'This computer',
    health: 'local'
  },
  { id: 'ssh:work', kind: 'ssh', label: 'Work', detail: 'SSH', health: 'available' }
] as const

/** A top-level or nested project group. */
function group(id: string, parentGroupId: string | null = null, tabOrder = 0): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

/** A project, on this machine unless `connectionId` names an SSH target. */
function repo(id: string, projectGroupId: string | null, connectionId?: string): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    projectGroupId,
    ...(connectionId ? { connectionId } : {})
  }
}

/** A worktree of `owner` on `branch`. */
function worktree(owner: Repo, branch = 'main'): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: row grouping reads only these fields.
  return {
    id: `${owner.id}::/${owner.id}/${branch}`,
    repoId: owner.id,
    path: `/${owner.id}/${branch}`,
    displayName: branch,
    branch: `refs/heads/${branch}`,
    head: 'abc',
    isBare: false,
    isMainWorktree: branch === 'main',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  } as Worktree
}

/** A host or header row's label, with a host's workspace badge or a group's count; other rows have none. */
function headerLabels(row: HostSectionRow): string[] {
  if (row.type === 'host-header') {
    return [`${row.key}(${row.count})`]
  }
  if (row.type !== 'header') {
    return []
  }
  return [row.projectGroup && !row.repo ? `${row.label}:${row.count}` : (row.label ?? row.key)]
}

/** The sidebar's host and header rows, top to bottom, with each group's count. */
function sidebarOrder(
  repos: Repo[],
  projectGroups: ProjectGroup[],
  collapsedGroupIds: string[],
  extraWorktrees: Worktree[] = []
): string[] {
  const rows = buildRows(
    'repo',
    [...repos.map((entry) => worktree(entry)), ...extraWorktrees],
    new Map(repos.map((entry) => [entry.id, entry])),
    null,
    new Set(collapsedGroupIds.map(getProjectGroupHeaderKey)),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    projectGroups
  )
  return addHostSectionRows({
    rows,
    hostOptions: [...HOST_OPTIONS],
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: ['local', 'ssh:work'],
    defaultHostId: 'local',
    localHostLabel: 'Local Mac',
    preferProjectGrouping: true
  }).flatMap(headerLabels)
}

describe('collapsed project groups in host sections', () => {
  it('stays under each host that owns its projects', () => {
    expect(
      sidebarOrder(
        [
          repo('payments', 'bank'),
          repo('ledger', 'bank'),
          repo('gateway', 'bank', 'work'),
          repo('cms', null),
          repo('api', null, 'work')
        ],
        [group('bank')],
        ['bank']
      )
    ).toEqual(['host:local(3)', 'bank:2', 'cms', 'host:ssh:work(2)', 'bank:1', 'api'])
  })

  it('keeps an expanded parent above its collapsed child', () => {
    expect(
      sidebarOrder(
        [repo('payments', 'archive'), repo('cms', 'live', 'work')],
        [group('clients'), group('archive', 'clients', 0), group('live', null, 1)],
        ['archive']
      )
    ).toEqual(['host:local(1)', 'clients:1', 'archive:1', 'host:ssh:work(1)', 'live:1', 'cms'])
  })

  it("counts every workspace of a collapsed group's projects in the host badge", () => {
    const payments = repo('payments', 'bank')
    expect(
      sidebarOrder(
        [payments, repo('api', null, 'work')],
        [group('bank')],
        ['bank'],
        [worktree(payments, 'fix-fees'), worktree(payments, 'refunds')]
      )
    ).toEqual(['host:local(3)', 'bank:3', 'host:ssh:work(1)', 'api'])
  })
})
