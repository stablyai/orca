import { describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetup } from '../../../../../shared/project-types'
import type { Repo } from '../../../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../../../shared/project-host-setup-projection'
import {
  buildSettingsProjectList,
  getSettingsProjectHostRepo,
  getSettingsProjectRemovalScope,
  getSettingsTargetHostSelection,
  removeSettingsProjectFromAllHosts,
  resolveSettingsTargetRepoId
} from './settings-project-list'

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  } satisfies Repo
}

function makeSetup(
  overrides: Partial<ProjectHostSetup> & Pick<ProjectHostSetup, 'hostId'>
): ProjectHostSetup {
  return {
    id: `${overrides.hostId}:${overrides.repoId ?? 'r'}`,
    projectId: 'p',
    repoId: overrides.repoId ?? 'r',
    path: '/repo',
    displayName: 'r',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } satisfies ProjectHostSetup
}

const gitRemote = {
  canonicalKey: 'gitlab.com/acme/app',
  remoteName: 'origin',
  remoteUrl: 'git@gitlab.com:acme/app.git'
}

describe('buildSettingsProjectList', () => {
  it('removes every registration of a physical checkout and resolves its alias deep link', async () => {
    const repos = [
      makeRepo({ id: 'identified', path: '/repos/app', gitRemoteIdentity: gitRemote }),
      makeRepo({ id: 'pending', path: '/repos/app' })
    ]
    const projection = projectHostSetupProjectionFromRepos(repos)
    for (const mode of ['repository', 'host', 'folder'] as const) {
      const entries = buildSettingsProjectList(repos, {
        projects: projection.projects,
        projectHostSetups: projection.setups,
        settings: { projectGroupingMode: mode }
      })
      expect(entries).toHaveLength(1)
      expect(getSettingsTargetHostSelection(entries, 'pending', 'local')).toMatchObject({
        selectionKey: entries[0].selectionKey,
        setupId: 'pending'
      })
      const remaining = new Set(repos.map((repo) => repo.id))
      await removeSettingsProjectFromAllHosts(entries[0].setups, async (id, { hostId }) => {
        expect(hostId).toBe('local')
        remaining.delete(id)
      })
      expect(remaining.size).toBe(0)
    }
  })

  it('groups same-host clones by repository by default and separates them when requested', () => {
    const repos = [
      makeRepo({ id: 'clone-a', gitRemoteIdentity: gitRemote }),
      makeRepo({ id: 'clone-b', gitRemoteIdentity: gitRemote })
    ]
    const projection = projectHostSetupProjectionFromRepos(repos)
    expect(buildSettingsProjectList(repos)).toHaveLength(1)
    const entries = buildSettingsProjectList(repos, {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: { projectGroupingMode: 'folder' }
    })
    expect(entries).toHaveLength(2)
    expect(entries.map(getSettingsProjectRemovalScope)).toEqual(['checkout', 'checkout'])
    expect(entries.map((entry) => entry.setups.map((setup) => setup.repoId))).toEqual([
      ['clone-a'],
      ['clone-b']
    ])
  })

  it('removes only the displayed host group', () => {
    const repos = [
      makeRepo({ id: 'clone-a', gitRemoteIdentity: gitRemote }),
      makeRepo({ id: 'clone-b', gitRemoteIdentity: gitRemote }),
      makeRepo({ id: 'remote', gitRemoteIdentity: gitRemote, executionHostId: 'ssh:box' })
    ]
    const projection = projectHostSetupProjectionFromRepos(repos)
    const entries = buildSettingsProjectList(repos, {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: { projectGroupingMode: 'host' }
    })
    expect(entries.map((entry) => entry.setups.map((setup) => setup.repoId))).toEqual([
      ['clone-a', 'clone-b'],
      ['remote']
    ])
    expect(entries.map(getSettingsProjectRemovalScope)).toEqual(['host:local', 'host:ssh:box'])
  })
})

describe('deep-link resolution', () => {
  it('disambiguates repo ids where one is a prefix of another (longest match wins)', () => {
    expect(
      resolveSettingsTargetRepoId({ repoId: null, sectionId: 'repo-app-2-icon' }, ['app', 'app-2'])
    ).toBe('app-2')
  })

  it('distinguishes same-id repo rows by execution host', () => {
    const sameIdRepos = [
      makeRepo({ id: 'same-repo', gitRemoteIdentity: gitRemote }),
      makeRepo({
        id: 'same-repo',
        gitRemoteIdentity: gitRemote,
        executionHostId: 'runtime:home-mac',
        path: '/remote/repo'
      })
    ]
    const sameIdProjects = buildSettingsProjectList(sameIdRepos)

    expect(
      getSettingsProjectHostRepo(sameIdProjects[0], sameIdRepos, 'runtime:home-mac')?.path
    ).toBe('/remote/repo')
  })

  it('selects a same-transport setup by setup id', () => {
    const directRepo = makeRepo({
      id: 'direct-repo',
      gitRemoteIdentity: gitRemote,
      executionHostId: 'runtime:home-mac',
      connectionId: 'direct-box',
      path: '/direct/repo'
    })
    const jumpRepo = makeRepo({
      id: 'jump-repo',
      gitRemoteIdentity: gitRemote,
      executionHostId: 'runtime:home-mac',
      connectionId: 'jump-box',
      path: '/jump/repo'
    })
    const sameHubProjects = buildSettingsProjectList([directRepo, jumpRepo])
    const jumpSetup = sameHubProjects[0].setups.find((setup) => setup.repoId === 'jump-repo')

    expect(
      getSettingsProjectHostRepo(
        sameHubProjects[0],
        [directRepo, jumpRepo],
        'runtime:home-mac',
        jumpSetup?.id
      )?.path
    ).toBe('/jump/repo')
  })
})

describe('removeSettingsProjectFromAllHosts', () => {
  it('awaits each host removal before starting the next', async () => {
    let resolveFirst: (() => void) | undefined
    const removeProject = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue(undefined)
    const setups = [
      makeSetup({ hostId: 'local', repoId: 'local-1' }),
      makeSetup({ hostId: 'runtime:home-mac', repoId: 'remote-9' })
    ]

    const pending = removeSettingsProjectFromAllHosts(setups, removeProject)
    await Promise.resolve()
    expect(removeProject).toHaveBeenCalledTimes(1)

    resolveFirst?.()
    await pending
    expect(removeProject).toHaveBeenCalledTimes(2)
  })
})
