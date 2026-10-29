import { describe, expect, it } from 'vitest'
import { addHostSectionRows } from '../../../../shared/sidebar-list/host-section-rows'
import type { HostSectionOption } from '../../../../shared/sidebar-list/host-section-rows'
import { planSidebarRows } from '../../../../shared/sidebar-list/sidebar-row-plan'
import type { WorktreeGroupBy } from '../../../../shared/sidebar-list/row-types'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import {
  repo,
  remoteRepo,
  worktree,
  remoteWorktree,
  makeDetectedWorktree,
  project,
  projectHostSetups
} from './worktree-list-groups-test-fixtures'

const hosts: HostSectionOption[] = [
  { id: 'local', kind: 'local', label: 'Local Mac', detail: '', health: 'local' },
  { id: 'ssh:gpu-vm', kind: 'ssh', label: 'Builder', detail: '', health: 'available' }
]

function rowsFor(groupBy: WorktreeGroupBy) {
  const worktrees = [worktree, { ...remoteWorktree, isPinned: true }]
  return planSidebarRows({
    groupBy,
    worktrees,
    repoMap: new Map([
      [repo.id, repo],
      [remoteRepo.id, remoteRepo]
    ]),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
    nestLineage: false,
    projectGroups: [],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map([
      [repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]
    ]),
    newExternalWorktreesInboxByRepo: new Map([
      [remoteRepo.id, { repo: remoteRepo, inboxWorktrees: [makeDetectedWorktree()] }]
    ]),
    pendingCreations: [],
    projectGrouping: { projects: [project], projectHostSetups },
    folderWorkspaces: [],
    hostLabelById: new Map(hosts.map((host) => [host.id, host.label])),
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'duplicate-in-groups',
    filterRepoIds: []
  }).render(new Set())
}

describe.each(['repo', 'workspace-status', 'pr-status', 'none'] as const)(
  'host context in %s grouping',
  (groupBy) => {
    it('names the host once above its cards and notices, including duplicate pinned rows', () => {
      const rows = rowsFor(groupBy)
      const sectioned = addHostSectionRows({
        rows,
        hostOptions: hosts,
        workspaceHostScope: 'all',
        visibleWorkspaceHostIds: hosts.map((host) => host.id),
        defaultHostId: 'local',
        localHostLabel: 'Local Mac',
        preferProjectGrouping: true
      })

      expect(sectioned.filter((row) => row.type === 'host-header').map((row) => row.label)).toEqual(
        ['Local Mac', 'Builder']
      )
      expect(sectioned.filter((row) => row.type === 'item')).toHaveLength(3)
      if (groupBy === 'repo') {
        expect(sectioned.filter((row) => row.type === 'imported-worktrees-card')).toHaveLength(1)
        expect(sectioned.filter((row) => row.type === 'new-external-worktrees-inbox')).toHaveLength(
          1
        )
      }
      for (const row of sectioned) {
        if ('hostContextLabel' in row) {
          expect(row.hostContextLabel).toBeUndefined()
        }
      }
      expect(rows.filter((row) => row.type === 'item').map((row) => row.hostContextLabel)).toEqual([
        'Builder',
        'Local Mac',
        'Builder'
      ])
    })

    it('keeps host labels when mixed rows have no enclosing host headers', () => {
      const rows = rowsFor(groupBy)
      const sectioned = addHostSectionRows({
        rows,
        hostOptions: hosts,
        workspaceHostScope: 'all',
        defaultHostId: 'local',
        localHostLabel: 'Local Mac',
        preferProjectGrouping: true
      })

      expect(sectioned).toEqual(rows)
      expect(
        sectioned.filter((row) => row.type === 'item').map((row) => row.hostContextLabel)
      ).toEqual(['Builder', 'Local Mac', 'Builder'])
    })
  }
)
