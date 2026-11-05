import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type {
  NestedRepoScanResult,
  ProjectGroup
} from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  canRefreshFolderProjectGroup,
  refreshFolderProjectGroup
} from './project-group-folder-refresh'

const group: ProjectGroup = {
  id: 'group-1',
  name: 'services',
  parentPath: '/projects/services',
  connectionId: null,
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

function repo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#ffffff',
    kind: 'git',
    addedAt: 0
  }
}

const scan: NestedRepoScanResult = {
  selectedPath: '/projects/services',
  selectedPathKind: 'non_git_folder',
  repos: [
    { path: '/projects/services/known', displayName: 'known', depth: 1 },
    { path: '/projects/services/new', displayName: 'new', depth: 1 },
    { path: '/projects/services/nested/child', displayName: 'child', depth: 2 }
  ],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 1,
  maxDepth: 3,
  maxRepos: 100,
  timeoutMs: null
}

describe('folder project group refresh', () => {
  it('imports new repos at any depth into the deepest matching folder group', async () => {
    const nestedGroup: ProjectGroup = {
      ...group,
      id: 'group-nested',
      name: 'nested',
      parentPath: '/projects/services/nested',
      parentGroupId: group.id
    }
    const knownRepo = repo('known', '/projects/services/known')
    const newRepo = repo('new', '/projects/services/new')
    const childRepo = repo('child', '/projects/services/nested/child')
    let repos = [knownRepo]
    const importNestedRepos = vi.fn(async () => {
      repos = [knownRepo, newRepo, childRepo]
      return {
        projects: [
          { path: newRepo.path, projectId: newRepo.id, status: 'imported' as const },
          { path: childRepo.path, projectId: childRepo.id, status: 'imported' as const }
        ],
        importedCount: 2,
        alreadyKnownCount: 0,
        failedCount: 0
      }
    })
    const moveProjectToGroup = vi.fn(async () => true)

    await refreshFolderProjectGroup(group, {
      getRepos: () => repos,
      getProjectGroups: () => [group, nestedGroup],
      scanNestedRepos: vi.fn(async () => scan),
      importNestedRepos,
      moveProjectToGroup
    })

    expect(importNestedRepos).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPath: group.parentPath,
        projectPaths: [newRepo.path, childRepo.path],
        runtimeEnvironmentId: null,
        mode: 'separate'
      })
    )
    expect(moveProjectToGroup).toHaveBeenCalledWith(newRepo, group.id)
    expect(moveProjectToGroup).toHaveBeenCalledWith(childRepo, nestedGroup.id)
  })

  it('warns instead of reporting nothing new when the scan stopped early', async () => {
    const warning = vi.spyOn(toast, 'warning').mockImplementation(() => '')
    const info = vi.spyOn(toast, 'info').mockImplementation(() => '')
    const importNestedRepos = vi.fn()

    await refreshFolderProjectGroup(group, {
      getRepos: () => scan.repos.map((entry) => repo(entry.displayName, entry.path)),
      getProjectGroups: () => [group],
      scanNestedRepos: vi.fn(async () => ({ ...scan, truncated: true })),
      importNestedRepos,
      moveProjectToGroup: vi.fn()
    })

    expect(importNestedRepos).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledTimes(1)
    expect(info).not.toHaveBeenCalled()
  })

  it('does not expose refresh for non-folder groups or SSH-owned folders', () => {
    expect(canRefreshFolderProjectGroup({ ...group, createdFrom: 'manual' })).toBe(false)
    expect(
      canRefreshFolderProjectGroup({
        ...group,
        executionHostId: 'ssh:target',
        connectionId: 'target'
      })
    ).toBe(false)
    expect(canRefreshFolderProjectGroup(group)).toBe(true)
  })
})
