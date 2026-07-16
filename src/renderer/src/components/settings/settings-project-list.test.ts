import { describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetup, Repo } from '../../../../shared/types'
import {
  buildRepoIdToHostSelection,
  buildRepoIdToRepresentative,
  buildSettingsProjectList,
  getSettingsProjectHostRepo,
  getSettingsProjectRepresentativeRepoId,
  removeSettingsProjectFromAllHosts,
  resolveEffectiveProjectHost,
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
  it('collapses a git same-remote pair on two hosts (different ids) into one project', () => {
    const repos: Repo[] = [
      makeRepo({ id: 'local-1', gitRemoteIdentity: gitRemote }),
      makeRepo({
        id: 'remote-9',
        gitRemoteIdentity: gitRemote,
        executionHostId: 'runtime:home-mac'
      })
    ]

    const projects = buildSettingsProjectList(repos)

    expect(projects).toHaveLength(1)
    expect(projects[0].setups).toHaveLength(2)
    // Representative is the local host's repo.
    expect(projects[0].representativeRepoId).toBe('local-1')
  })

  it('collapses a folder with the same id on local + runtime into one project', () => {
    const repos: Repo[] = [
      makeRepo({ id: 'folder-x', kind: 'folder' }),
      makeRepo({ id: 'folder-x', kind: 'folder', executionHostId: 'runtime:home-mac' })
    ]

    const projects = buildSettingsProjectList(repos)

    expect(projects).toHaveLength(1)
    expect(projects[0].setups).toHaveLength(2)
    expect(projects[0].representativeRepoId).toBe('folder-x')
  })

  it('keeps the representative stable when an unrelated host is removed', () => {
    const withRuntime: Repo[] = [
      makeRepo({ id: 'local-1', gitRemoteIdentity: gitRemote }),
      makeRepo({
        id: 'remote-9',
        gitRemoteIdentity: gitRemote,
        executionHostId: 'runtime:home-mac'
      })
    ]
    const localOnly: Repo[] = [makeRepo({ id: 'local-1', gitRemoteIdentity: gitRemote })]

    expect(buildSettingsProjectList(withRuntime)[0].representativeRepoId).toBe(
      buildSettingsProjectList(localOnly)[0].representativeRepoId
    )
  })
})

describe('getSettingsProjectRepresentativeRepoId', () => {
  it('prefers the local host setup', () => {
    const setups = [
      makeSetup({ hostId: 'runtime:home-mac', repoId: 'aaa' }),
      makeSetup({ hostId: 'local', repoId: 'zzz' })
    ]
    expect(getSettingsProjectRepresentativeRepoId(setups)).toBe('zzz')
  })

  it('falls back to the lowest repoId when there is no local setup', () => {
    const setups = [
      makeSetup({ hostId: 'runtime:home-mac', repoId: 'zzz' }),
      makeSetup({ hostId: 'ssh:box', repoId: 'aaa' })
    ]
    expect(getSettingsProjectRepresentativeRepoId(setups)).toBe('aaa')
  })
})

describe('resolveEffectiveProjectHost', () => {
  const setups = [
    makeSetup({ hostId: 'local', repoId: 'local-1' }),
    makeSetup({ hostId: 'runtime:home-mac', repoId: 'remote-9' })
  ]

  it('keeps a valid stored selection', () => {
    expect(resolveEffectiveProjectHost(setups, 'runtime:home-mac')).toBe('runtime:home-mac')
  })

  it('falls back to local when the stored host no longer exists', () => {
    expect(resolveEffectiveProjectHost(setups, 'runtime:gone')).toBe('local')
  })

  it('falls back to the first ready setup when there is no local host', () => {
    const remoteSetups = [
      makeSetup({ hostId: 'ssh:box', repoId: 'a', setupState: 'not-set-up' }),
      makeSetup({ hostId: 'runtime:home-mac', repoId: 'b', setupState: 'ready' })
    ]
    expect(resolveEffectiveProjectHost(remoteSetups, 'runtime:gone')).toBe('runtime:home-mac')
  })

  it('returns undefined when there are no setups', () => {
    expect(resolveEffectiveProjectHost([], 'local')).toBeUndefined()
  })
})

describe('deep-link resolution', () => {
  const repos: Repo[] = [
    makeRepo({ id: 'local-1', gitRemoteIdentity: gitRemote }),
    makeRepo({ id: 'remote-9', gitRemoteIdentity: gitRemote, executionHostId: 'runtime:home-mac' })
  ]
  const projects = buildSettingsProjectList(repos)

  it('maps every host repoId to the representative section (getSettingsSectionId resolver)', () => {
    const map = buildRepoIdToRepresentative(projects)
    expect(map.get('remote-9')).toBe('local-1')
    expect(map.get('local-1')).toBe('local-1')
  })

  it('maps a repoId to its owning project + host for selection', () => {
    const map = buildRepoIdToHostSelection(projects)
    expect(map.get('remote-9')).toEqual({
      projectId: projects[0].projectId,
      hostId: 'runtime:home-mac'
    })
  })

  it('parses a repoId from a host-specific subsection sectionId', () => {
    const repoIds = [...buildRepoIdToHostSelection(projects).keys()]
    expect(
      resolveSettingsTargetRepoId(
        { repoId: null, sectionId: 'repo-remote-9-source-control-ai' },
        repoIds
      )
    ).toBe('remote-9')
  })

  it('prefers an explicit target repoId over the sectionId', () => {
    expect(
      resolveSettingsTargetRepoId({ repoId: 'local-1', sectionId: 'repo-remote-9-icon' }, [
        'local-1',
        'remote-9'
      ])
    ).toBe('local-1')
  })

  it('disambiguates repo ids where one is a prefix of another (longest match wins)', () => {
    expect(
      resolveSettingsTargetRepoId({ repoId: null, sectionId: 'repo-app-2-icon' }, ['app', 'app-2'])
    ).toBe('app-2')
  })

  it('resolves the remote host repo row when a remote host is selected', () => {
    const hostSelection = buildRepoIdToHostSelection(projects).get('remote-9')
    expect(getSettingsProjectHostRepo(projects[0], repos, hostSelection?.hostId)?.id).toBe(
      'remote-9'
    )
  })

  it('defaults to the local host repo row when no host is selected', () => {
    expect(getSettingsProjectHostRepo(projects[0], repos, undefined)?.id).toBe('local-1')
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
})

describe('removeSettingsProjectFromAllHosts', () => {
  it('removes every host setup with its own hostId and skips setups without a repo row', async () => {
    const removeProject = vi.fn().mockResolvedValue(undefined)
    const setups = [
      makeSetup({ hostId: 'local', repoId: 'local-1' }),
      makeSetup({ hostId: 'ssh:box', repoId: '  ' }),
      makeSetup({ hostId: 'runtime:home-mac', repoId: 'remote-9' })
    ]

    await removeSettingsProjectFromAllHosts(setups, removeProject)

    expect(removeProject.mock.calls).toEqual([
      ['local-1', { hostId: 'local' }],
      ['remote-9', { hostId: 'runtime:home-mac' }]
    ])
  })

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
