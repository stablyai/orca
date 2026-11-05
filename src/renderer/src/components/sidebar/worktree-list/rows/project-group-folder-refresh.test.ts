import { describe, expect, it, vi } from 'vitest'
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
  it('imports only new direct child repos and adds them to the existing group', async () => {
    const knownRepo = repo('known', '/projects/services/known')
    const newRepo = repo('new', '/projects/services/new')
    let repos = [knownRepo]
    const scanNestedRepos = vi.fn(async () => scan)
    const importNestedRepos = vi.fn(async () => {
      repos = [knownRepo, newRepo]
      return {
        projects: [{ path: newRepo.path, projectId: newRepo.id, status: 'imported' as const }],
        importedCount: 1,
        alreadyKnownCount: 0,
        failedCount: 0
      }
    })
    const moveProjectToGroup = vi.fn(async () => true)

    await refreshFolderProjectGroup(group, {
      getRepos: () => repos,
      scanNestedRepos,
      importNestedRepos,
      moveProjectToGroup
    })

    expect(importNestedRepos).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPath: group.parentPath,
        projectPaths: [newRepo.path],
        runtimeEnvironmentId: null,
        mode: 'separate'
      })
    )
    expect(moveProjectToGroup).toHaveBeenCalledWith(newRepo, group.id)
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
