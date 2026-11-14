import { describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetup } from '../../../../../shared/project-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import {
  buildSettingsProjectList,
  getSettingsProjectHostRepo,
  getSettingsEntryHostSelection,
  getSettingsProjectRemovalScope,
  removeSettingsProjectFromAllHosts
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
  it("keeps a clone's host pick when its sibling clone is removed", () => {
    const cloneA = makeRepo({ id: 'clone-a', gitRemoteIdentity: gitRemote })
    const cloneATwin = makeRepo({
      id: 'clone-a',
      gitRemoteIdentity: gitRemote,
      executionHostId: 'runtime:mac'
    })
    const cloneB = makeRepo({ id: 'clone-b', gitRemoteIdentity: gitRemote })
    const [splitCloneA] = buildSettingsProjectList([cloneA, cloneB, cloneATwin])
    const hostSelection: Record<string, ExecutionHostId> = {
      [splitCloneA.selectionKey]: 'runtime:mac'
    }

    const [unsplit] = buildSettingsProjectList([cloneA, cloneATwin])

    expect(unsplit.selectionKey).not.toBe(splitCloneA.selectionKey)
    expect(getSettingsEntryHostSelection(unsplit, hostSelection, {}).hostId).toBe('runtime:mac')
  })

  it("does not take a sibling clone's host pick", () => {
    const projects = buildSettingsProjectList([
      makeRepo({ id: 'clone-a', gitRemoteIdentity: gitRemote }),
      makeRepo({ id: 'clone-b', gitRemoteIdentity: gitRemote })
    ])
    const hostSelection: Record<string, ExecutionHostId> = { [projects[1].selectionKey]: 'local' }

    expect(getSettingsEntryHostSelection(projects[0], hostSelection, {}).hostId).toBeUndefined()
  })

  it('keeps other hosts in a project-level entry when same-host clones split', () => {
    const repos: Repo[] = [
      makeRepo({ id: 'clone-a', gitRemoteIdentity: gitRemote }),
      makeRepo({ id: 'clone-b', gitRemoteIdentity: gitRemote }),
      makeRepo({ id: 'remote-9', gitRemoteIdentity: gitRemote, executionHostId: 'ssh:box' })
    ]

    const projects = buildSettingsProjectList(repos)

    expect(projects.map((entry) => entry.setups.map((setup) => setup.repoId))).toEqual([
      ['clone-a'],
      ['clone-b'],
      ['remote-9']
    ])
    expect(projects[2].checkoutLabel).toBeUndefined()
    expect(projects.map(getSettingsProjectRemovalScope)).toEqual([
      'checkout',
      'checkout',
      'split-project'
    ])
  })
})

describe('deep-link resolution', () => {
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
