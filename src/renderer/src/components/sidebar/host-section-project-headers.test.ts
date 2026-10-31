import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import {
  hosts,
  otherRepo,
  otherWorktree,
  hostSectionRows
} from './host-section-project-header-test-fixtures'
import { describe, expect, it } from 'vitest'

import {
  type HostSectionRow,
  type HostSectionOption,
  addHostSectionRows
} from '../../../../shared/sidebar-list/host-section-rows'
import { planSidebarRows } from '../../../../shared/sidebar-list/sidebar-row-plan'
import { createHostScopedRepoOf } from '../../../../shared/sidebar-list/sidebar-feed-index'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import {
  repo,
  remoteRepo,
  worktree,
  remoteWorktree,
  project,
  describeHostSectionRow
} from './worktree-list-groups-test-fixtures'
describe('a project checked out on two hosts, in host sections', () => {
  it("heads each host's rows with that host's own project header", () => {
    expect(hostSectionRows(new Set()).map(describeHostSectionRow)).toEqual([
      'host:local (2)',
      `project:${project.id} @${repo.id} (1)`,
      worktree.id,
      `repo:${otherRepo.id} @${otherRepo.id} (1)`,
      otherWorktree.id,
      'host:ssh:gpu-vm (1)',
      `project:${project.id} @${remoteRepo.id} (1)`,
      remoteWorktree.id
    ])
  })

  it('keeps a collapsed copy in each host section with that host’s count', () => {
    const rows = hostSectionRows(new Set([`project:${project.id}`]))

    expect(rows.map(describeHostSectionRow)).toEqual([
      'host:local (2)',
      `project:${project.id} @${repo.id} (1)`,
      `repo:${otherRepo.id} @${otherRepo.id} (1)`,
      otherWorktree.id,
      'host:ssh:gpu-vm (1)',
      `project:${project.id} @${remoteRepo.id} (1)`
    ])
    expect(rows.flatMap((row) => (row.type === 'header' && row.repo ? [row.hostId] : []))).toEqual([
      'local',
      'local',
      'ssh:gpu-vm'
    ])
  })
})

describe('one repo id registered on two hosts, in host sections', () => {
  const localTwin: Repo = { ...repo, id: 'repo-twin' }
  const sshTwin: Repo = { ...localTwin, path: '/home/alice/twin', connectionId: 'gpu-vm' }
  const runtimeHost: HostSectionOption = {
    id: 'runtime:env',
    kind: 'runtime',
    label: 'Server',
    detail: '',
    health: 'available'
  }
  const runtimeRepo: Repo = { ...repo, id: 'repo-runtime', executionHostId: 'runtime:env' }

  function twinSectionRows(
    worktrees: Worktree[],
    repoMapOrder: Repo[],
    visibleWorkspaceHostIds: ExecutionHostId[]
  ): HostSectionRow[] {
    const repoMap = new Map(repoMapOrder.map((entry) => [entry.id, entry]))
    const rows = planSidebarRows({
      groupBy: 'repo',
      worktrees,
      repoMap,
      repoOfWorktree: createHostScopedRepoOf([localTwin, sshTwin, runtimeRepo], repoMap),
      prGroupOf: () => 'in-progress',
      workspaceStatuses: cloneDefaultWorkspaceStatuses(),
      projectOrderBy: 'manual',
      lineageById: {},
      worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
      nestLineage: false,
      projectGroups: [],
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingCreations: [],
      folderWorkspaces: [],
      defaultHostId: 'local',
      pinnedDisplayPolicy: 'single-location',
      filterRepoIds: []
    }).render(new Set())
    return addHostSectionRows({
      rows,
      hostOptions: [...hosts, runtimeHost],
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds,
      defaultHostId: 'local',
      localHostLabel: 'Local Mac',
      preferProjectGrouping: true
    })
  }

  function headerHosts(rows: HostSectionRow[]): [string | undefined, string | undefined][] {
    return rows.flatMap((row) =>
      row.type === 'header' && row.repo ? [[row.hostId, getRepoExecutionHostId(row.repo)]] : []
    )
  }

  const sshWorktree: Worktree = {
    ...worktree,
    id: 'wt-twin-ssh',
    repoId: sshTwin.id,
    hostId: 'ssh:gpu-vm'
  }
  const runtimeWorktree: Worktree = { ...worktree, id: 'wt-runtime', repoId: runtimeRepo.id }

  it.each<[string, ExecutionHostId[]]>([
    ['an empty second host', ['ssh:gpu-vm', 'runtime:env']],
    ['one visible host', ['ssh:gpu-vm']]
  ])('names the shown host’s registration when %s leaves no host sections', (_, visible) => {
    const rows = twinSectionRows([sshWorktree], [localTwin, runtimeRepo], visible)

    expect(rows.some((row) => row.type === 'host-header')).toBe(false)
    expect(headerHosts(rows)).toEqual([['ssh:gpu-vm', 'ssh:gpu-vm']])
  })

  it('does not open a section for a hidden host that only anchors the header', () => {
    const rows = twinSectionRows(
      [sshWorktree, runtimeWorktree],
      [localTwin, runtimeRepo],
      ['ssh:gpu-vm', 'runtime:env']
    )

    expect(rows.filter((row) => row.type === 'host-header').map((row) => row.hostId)).toEqual([
      'ssh:gpu-vm',
      'runtime:env'
    ])
    expect(headerHosts(rows)).toEqual([
      ['ssh:gpu-vm', 'ssh:gpu-vm'],
      ['runtime:env', 'runtime:env']
    ])
  })
})
