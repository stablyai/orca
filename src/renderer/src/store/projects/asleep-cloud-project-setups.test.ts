import { describe, expect, it } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { planSidebarRows } from '../../../../shared/sidebar-list/sidebar-row-plan'
import { createHostScopedRepoOf } from '../../../../shared/sidebar-list/sidebar-feed-index'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import { getProjectHostSetupProjectionFromState } from './project-host-setup-selector'
import type { EphemeralVmWorkspaceRuntime } from '../slices/ephemeral-vm/ephemeral-vm-lifecycle'

// The state after an app restart with an Orca Cloud workspace asleep, as seen on m4air (RA-9):
// the runtime's catalog never loaded, so terminal hydration left a placeholder repo named after
// the workspace folder, and there is no setup filing it under its project.
const local: Repo = {
  id: 'repo-local',
  path: '/Users/me/Hello-World',
  displayName: 'Hello-World',
  badgeColor: '#000000',
  addedAt: 1,
  executionHostId: 'local'
}
const placeholder: Repo = {
  id: 'repo-cloud',
  path: '/vercel/orca/workspaces/project/ra9-asleep',
  displayName: 'ra9-asleep',
  badgeColor: '#737373',
  addedAt: 0,
  connectionId: null,
  executionHostId: 'runtime:env-1'
}
const project: Project = {
  id: 'github:octocat/hello-world',
  displayName: 'Hello-World',
  badgeColor: '#000000',
  kind: 'git',
  sourceRepoIds: ['repo-local'],
  createdAt: 1,
  updatedAt: 1
}
const localSetup: ProjectHostSetup = {
  id: 'repo-local',
  projectId: project.id,
  hostId: 'local',
  repoId: 'repo-local',
  path: local.path,
  displayName: 'Hello-World',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1
}
const workspace: Worktree = {
  id: 'repo-cloud::/vercel/orca/workspaces/project/ra9-asleep',
  repoId: 'repo-cloud',
  hostId: 'runtime:env-1',
  path: placeholder.path,
  head: '',
  branch: '',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
  displayName: 'ra9-asleep',
  sortOrder: 0,
  lastActivityAt: 0
}
const vmRuntimes: Record<string, EphemeralVmWorkspaceRuntime> = {
  [workspace.id]: {
    id: 'orca-1',
    workspaceId: workspace.id,
    status: 'suspended',
    runtimeEnvironmentId: 'env-1',
    canSuspend: true,
    projectId: project.id
  }
}

function projectHeaderOf(vm: Record<string, EphemeralVmWorkspaceRuntime> | undefined) {
  const repos = [local, placeholder]
  const projection = getProjectHostSetupProjectionFromState({
    repos,
    projects: [project],
    projectHostSetups: [localSetup],
    ephemeralVmRuntimesByWorkspaceId: vm
  })
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  const rows = planSidebarRows({
    groupBy: 'repo',
    sortBy: 'smart',
    worktrees: [workspace],
    repoMap,
    repoOfWorktree: createHostScopedRepoOf(repos, repoMap),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map([[workspace.id, workspace]]),
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
    projectGrouping: { projects: projection.projects, projectHostSetups: projection.setups }
  }).render(new Set())
  return rows.find((row) => row.type === 'header')?.label
}

describe('an asleep Orca Cloud workspace after a restart (RA-9)', () => {
  it('stays under its project, not a group named after its folder', () => {
    expect(projectHeaderOf(vmRuntimes)).toBe('Hello-World')
  })

  it('reproduces the bug without the VM record (the old behavior)', () => {
    expect(projectHeaderOf(undefined)).toBe('ra9-asleep')
  })

  it('adds no stand-in once the runtime answers with its own setup', () => {
    const own: ProjectHostSetup = {
      ...localSetup,
      id: 'cloud-own',
      hostId: 'runtime:env-1',
      repoId: 'repo-cloud',
      path: placeholder.path
    }
    const projection = getProjectHostSetupProjectionFromState({
      repos: [local, placeholder],
      projects: [project],
      projectHostSetups: [localSetup, own],
      ephemeralVmRuntimesByWorkspaceId: vmRuntimes
    })
    expect(projection.setups.filter((setup) => setup.repoId === 'repo-cloud')).toHaveLength(1)
  })
})
