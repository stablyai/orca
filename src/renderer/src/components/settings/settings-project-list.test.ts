import { describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  buildRepoIdToHostSelection,
  buildRepoIdToRepresentative,
  buildSettingsProjectList,
  getSettingsProjectHostRepo,
  getSettingsProjectRepresentativeRepoId,
  getSettingsTargetHostSelection,
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

  it('maps a repoId to its owning project + host + setup for selection', () => {
    const map = buildRepoIdToHostSelection(projects)
    expect(map.get('remote-9')).toEqual({
      projectId: projects[0].projectId,
      hostId: 'runtime:home-mac',
      setupId: 'remote-9'
    })
  })

  it('splits same-host clones of one project into a settings entry per checkout (#18493)', () => {
    // Two local clones of the same remote: one merged project, two distinct `local` checkouts.
    const cloneRepos: Repo[] = [
      makeRepo({ id: 'ios', gitRemoteIdentity: gitRemote, path: '/repos/ios' }),
      makeRepo({ id: 'ios2', gitRemoteIdentity: gitRemote, path: '/repos/ios2' })
    ]
    const cloneProjects = buildSettingsProjectList(cloneRepos)
    // One settings entry per checkout, mirroring the sidebar's per-checkout rows.
    expect(cloneProjects).toHaveLength(2)
    const byRepo = new Map(cloneProjects.map((entry) => [entry.representativeRepoId, entry]))
    expect([...byRepo.keys()].sort()).toEqual(['ios', 'ios2'])
    // Each entry renders/edits its own checkout even with no explicit selection.
    expect(getSettingsProjectHostRepo(byRepo.get('ios')!, cloneRepos, undefined)?.path).toBe(
      '/repos/ios'
    )
    expect(getSettingsProjectHostRepo(byRepo.get('ios2')!, cloneRepos, undefined)?.path).toBe(
      '/repos/ios2'
    )
    // Deep-link maps resolve each clone to its own section, not a shared representative.
    const rep = buildRepoIdToRepresentative(cloneProjects)
    expect(rep.get('ios')).toBe('ios')
    expect(rep.get('ios2')).toBe('ios2')
    // Each checkout still carries its own setupId for precise deep-link selection.
    const hostSelection = buildRepoIdToHostSelection(cloneProjects)
    expect(hostSelection.get('ios2')).toEqual({
      projectId: byRepo.get('ios2')!.projectId,
      hostId: 'local',
      setupId: 'ios2'
    })
  })

  it('uses an explicit host when same-id repo rows collide', () => {
    const sameIdProjects = buildSettingsProjectList([
      makeRepo({ id: 'same-repo', gitRemoteIdentity: gitRemote }),
      makeRepo({
        id: 'same-repo',
        gitRemoteIdentity: gitRemote,
        executionHostId: 'ssh:server',
        connectionId: 'server',
        path: '/remote/repo'
      })
    ])

    expect(getSettingsTargetHostSelection(sameIdProjects, 'same-repo', 'ssh:server')).toEqual(
      expect.objectContaining({
        projectId: sameIdProjects[0].projectId,
        hostId: 'ssh:server'
      })
    )
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

  it('splits distinct checkouts sharing one runtime host into an entry per checkout', () => {
    const directRepo = makeRepo({
      id: 'direct-repo',
      gitRemoteIdentity: gitRemote,
      executionHostId: 'runtime:home-mac',
      path: '/direct/repo'
    })
    const jumpRepo = makeRepo({
      id: 'jump-repo',
      gitRemoteIdentity: gitRemote,
      executionHostId: 'runtime:home-mac',
      path: '/jump/repo'
    })
    const sameHubProjects = buildSettingsProjectList([directRepo, jumpRepo])
    expect(sameHubProjects).toHaveLength(2)
    const byRepo = new Map(sameHubProjects.map((entry) => [entry.representativeRepoId, entry]))

    expect(
      getSettingsProjectHostRepo(
        byRepo.get('jump-repo')!,
        [directRepo, jumpRepo],
        'runtime:home-mac'
      )?.path
    ).toBe('/jump/repo')
    expect(
      getSettingsProjectHostRepo(
        byRepo.get('direct-repo')!,
        [directRepo, jumpRepo],
        'runtime:home-mac'
      )?.path
    ).toBe('/direct/repo')
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

    // errorFeedback: this is a user-initiated removal, so a failure must surface (#11994).
    expect(removeProject.mock.calls).toEqual([
      ['local-1', { hostId: 'local', errorFeedback: 'toast' }],
      ['remote-9', { hostId: 'runtime:home-mac', errorFeedback: 'toast' }]
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
