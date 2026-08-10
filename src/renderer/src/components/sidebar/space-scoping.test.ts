import { describe, expect, it } from 'vitest'
import type { ProjectGroup, Repo } from '../../../../shared/types'
import { DEFAULT_SPACE_ID } from '../../../../shared/spaces'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import {
  filterReposForActiveSpace,
  getActiveSpaceFilterId,
  getActiveSpaceProjectGroupIdSet,
  isWorktreeInActiveSpace
} from './space-scoping'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function group(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    connectionId: null,
    executionHostId: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('active Space filtering', () => {
  it('preserves the pre-Spaces fast path and activates filtering when needed', () => {
    const defaultRepos = [repo('a'), repo('b', { spaceId: null })]

    expect(getActiveSpaceFilterId(DEFAULT_SPACE_ID, defaultRepos)).toBeNull()
    expect(getActiveSpaceFilterId(DEFAULT_SPACE_ID, [repo('a', { spaceId: 'space-a' })])).toBe(
      DEFAULT_SPACE_ID
    )
    expect(getActiveSpaceFilterId('space-a', defaultRepos)).toBe('space-a')
    expect(filterReposForActiveSpace(defaultRepos, null)).toBe(defaultRepos)
  })

  it('keeps only worktrees and projects belonging to the active Space', () => {
    const repos = [repo('default'), repo('work', { spaceId: 'space-a' })]
    const repoMap = new Map(repos.map((entry) => [entry.id, entry]))

    expect(isWorktreeInActiveSpace({ repoId: 'work' }, repoMap, null)).toBe(true)
    expect(isWorktreeInActiveSpace({ repoId: 'default' }, repoMap, DEFAULT_SPACE_ID)).toBe(true)
    expect(isWorktreeInActiveSpace({ repoId: 'work' }, repoMap, DEFAULT_SPACE_ID)).toBe(false)
    expect(isWorktreeInActiveSpace({ repoId: 'missing' }, repoMap, DEFAULT_SPACE_ID)).toBe(false)
    expect(filterReposForActiveSpace(repos, 'space-a').map((entry) => entry.id)).toEqual(['work'])

    // Same project id on two hosts: host identity decides which Space the workspace belongs to.
    const local = repo('shared', { executionHostId: 'local' })
    const remote = repo('shared', { spaceId: 'space-a', executionHostId: 'ssh:server' })
    const byHost = new Map([local, remote].map((entry) => [getRepoHostIdentity(entry), entry]))
    const byId = new Map([['shared', remote]])

    expect(
      isWorktreeInActiveSpace({ repoId: 'shared', hostId: 'local' }, byId, DEFAULT_SPACE_ID, byHost)
    ).toBe(true)
    expect(
      isWorktreeInActiveSpace(
        { repoId: 'shared', hostId: 'ssh:server' },
        byId,
        DEFAULT_SPACE_ID,
        byHost
      )
    ).toBe(false)
  })

  it('inherits group membership through ancestors and keeps unclaimed groups visible everywhere', () => {
    const groups = [
      group('parent'),
      group('child', { parentGroupId: 'parent' }),
      group('empty'),
      group('default')
    ]
    const repos = [
      repo('work', { spaceId: 'space-a', projectGroupId: 'child' }),
      repo('default', { projectGroupId: 'default' })
    ]

    // Why: 'empty' holds no Space-bearing project — a folder-workspace-only group looks the same,
    // and hiding it outside Default would strand it with no way to move it into a Space.
    expect([...(getActiveSpaceProjectGroupIdSet(groups, repos, 'space-a') ?? [])].sort()).toEqual([
      'child',
      'empty',
      'parent'
    ])
    expect(
      [...(getActiveSpaceProjectGroupIdSet(groups, repos, DEFAULT_SPACE_ID) ?? [])].sort()
    ).toEqual(['default', 'empty'])
  })

  it('exempts runtime-owned projects, which never carry Space membership', () => {
    const runtime = repo('remote', { executionHostId: 'runtime:env-1', projectGroupId: 'remote' })
    const local = repo('work', { spaceId: 'space-a', projectGroupId: 'work' })

    // Under a runtime environment every row resolves to Default; scoping them would empty the sidebar.
    expect(filterReposForActiveSpace([runtime, local], 'space-a').map((entry) => entry.id)).toEqual(
      ['remote', 'work']
    )

    const byId = new Map([['remote', runtime]])
    expect(isWorktreeInActiveSpace({ repoId: 'remote' }, byId, 'space-a')).toBe(true)

    const groups = [group('remote'), group('work')]
    expect(
      [...(getActiveSpaceProjectGroupIdSet(groups, [runtime, local], 'space-a') ?? [])].sort()
    ).toEqual(['remote', 'work'])
  })
})
