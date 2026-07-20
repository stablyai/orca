import { describe, expect, it } from 'vitest'
import { getMissionEligibleGroupRepoIds } from './mission-group-selection'
import type { Project, ProjectGroup, Repo } from '../../../../shared/types'

function makeGroup(overrides: Partial<ProjectGroup> & { id: string }): ProjectGroup {
  return {
    name: overrides.id,
    parentPath: null,
    connectionId: null,
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

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

describe('getMissionEligibleGroupRepoIds', () => {
  it('collects native local repos across the group subtree', () => {
    const groups = [makeGroup({ id: 'root' }), makeGroup({ id: 'child', parentGroupId: 'root' })]
    const repos = [
      makeRepo({ id: 'a', projectGroupId: 'root' }),
      makeRepo({ id: 'b', projectGroupId: 'child' }),
      makeRepo({ id: 'runtime', projectGroupId: 'root', executionHostId: 'runtime:env-1' }),
      makeRepo({ id: 'ssh', projectGroupId: 'root', connectionId: 'target-1' }),
      makeRepo({ id: 'folder', projectGroupId: 'root', kind: 'folder' }),
      makeRepo({
        id: 'wsl',
        projectGroupId: 'child',
        path: '\\\\wsl.localhost\\Ubuntu\\repos\\wsl'
      }),
      makeRepo({ id: 'outside', projectGroupId: null })
    ]
    const context = { projects: [] as Project[], settings: null, appPlatform: 'linux' as const }
    expect(getMissionEligibleGroupRepoIds(groups, repos, 'root', context)).toEqual(['a', 'b'])
    expect(getMissionEligibleGroupRepoIds(groups, repos, 'child', context)).toEqual(['b'])
  })

  it('excludes group repos whose Windows project runtime resolves to WSL', () => {
    const groups = [makeGroup({ id: 'root' })]
    const repos = [
      makeRepo({ id: 'host', projectGroupId: 'root' }),
      makeRepo({ id: 'wsl', projectGroupId: 'root' })
    ]
    const projects = [
      {
        id: 'host-project',
        displayName: 'Host',
        badgeColor: '#000',
        localWindowsRuntimePreference: { kind: 'windows-host' as const },
        sourceRepoIds: ['host'],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'wsl-project',
        displayName: 'WSL',
        badgeColor: '#000',
        sourceRepoIds: ['wsl'],
        createdAt: 1,
        updatedAt: 1
      }
    ]

    expect(
      getMissionEligibleGroupRepoIds(groups, repos, 'root', {
        projects,
        settings: { localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } },
        appPlatform: 'win32'
      })
    ).toEqual(['host'])
  })
})
