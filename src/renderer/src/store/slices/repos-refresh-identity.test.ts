import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Repo } from '../../../../shared/types'
import { getSetupScriptPromptDismissalKey } from '../../lib/setup-script-prompt'
import { getRepoHostIdentityForParts } from './repo-host-identity'
import { createTestStore } from './store-test-helpers'

// Why: every field here is load-bearing. A scalar-only repo reconciles even when the structural
// compare is broken, which is exactly how an earlier version of this work shipped green and inert.
// addedAt is non-zero on this fixture so the default case still exercises a real timestamp;
// dedicated tests below cover addedAt 0 / omitted without restamping Date.now().
const repo: Repo = {
  id: 'repo-1',
  path: '/repo-1',
  displayName: 'Repo 1',
  badgeColor: '#000000',
  addedAt: 1_700_000_000_000,
  executionHostId: 'local',
  kind: 'git',
  repoIcon: { type: 'lucide', name: 'Box' },
  upstream: { owner: 'upstream-owner', repo: 'repo-1', host: 'github.com' },
  gitRemoteIdentity: {
    canonicalKey: 'github.com/octocat/repo-1',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:octocat/repo-1.git'
  },
  hookSettings: { mode: 'auto', scripts: { setup: 'echo hi', archive: '' } },
  symlinkPaths: ['.env', 'node_modules'],
  importedExternalWorktreePaths: []
}

const secondRepo: Repo = {
  ...repo,
  id: 'repo-2',
  path: '/repo-2',
  displayName: 'Repo 2',
  addedAt: 1_700_000_001_000,
  upstream: { owner: 'upstream-owner', repo: 'repo-2', host: 'github.com' },
  gitRemoteIdentity: {
    canonicalKey: 'github.com/octocat/repo-2',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:octocat/repo-2.git'
  }
}

const reposList = vi.fn()
const projectsList = vi.fn()
const listHostSetups = vi.fn()

// Why: catalogs arrive over IPC, so every fetch must hand back freshly allocated objects —
// otherwise identity would match by accident and prove nothing.
function clone<T>(value: T): T {
  return structuredClone(value)
}

function mockRepos(...rows: readonly (Repo | Omit<Repo, 'addedAt'>)[]): void {
  reposList.mockImplementation(async () => rows.map(clone))
}

function omitAddedAt(row: Repo): Omit<Repo, 'addedAt'> {
  const { addedAt: _addedAt, ...rest } = row
  return rest
}

beforeEach(() => {
  reposList.mockReset()
  projectsList.mockReset()
  listHostSetups.mockReset()
  mockRepos(repo)
  projectsList.mockImplementation(async () => [])
  listHostSetups.mockImplementation(async () => [])

  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups }
    },
    dispatchEvent: vi.fn()
  })
})

describe('repo catalog refresh identity', () => {
  it('keeps the projects and host setups arrays and entries across a no-op refetch', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    const projects = store.getState().projects
    const setups = store.getState().projectHostSetups
    expect(projects).toHaveLength(1)
    expect(setups).toHaveLength(1)

    await store.getState().fetchRepos()

    expect(store.getState().projects).toBe(projects)
    expect(store.getState().projects[0]).toBe(projects[0])
    expect(store.getState().projectHostSetups).toBe(setups)
    expect(store.getState().projectHostSetups[0]).toBe(setups[0])
  })

  it('lets a nested hookSettings change through', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    const setups = store.getState().projectHostSetups

    mockRepos({ ...repo, hookSettings: { mode: 'override', scripts: { setup: '', archive: '' } } })
    await store.getState().fetchRepos()

    expect(store.getState().projectHostSetups).not.toBe(setups)
    expect(store.getState().projectHostSetups[0]?.hookSettings?.mode).toBe('override')
  })

  it('lets a displayName change through on projects', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    const projects = store.getState().projects

    mockRepos({ ...repo, displayName: 'Renamed' })
    await store.getState().fetchRepos()

    expect(store.getState().projects).not.toBe(projects)
    expect(store.getState().projects[0]?.displayName).toBe('Renamed')
  })

  it('lets an array-field change through', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    const repos = store.getState().repos

    mockRepos({ ...repo, symlinkPaths: ['.env'] })
    await store.getState().fetchRepos()

    expect(store.getState().repos).not.toBe(repos)
    expect(store.getState().repos[0]?.symlinkPaths).toEqual(['.env'])
  })

  it('lets a nested gitRemoteIdentity change through', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    const projects = store.getState().projects

    mockRepos({
      ...repo,
      gitRemoteIdentity: { ...repo.gitRemoteIdentity!, remoteName: 'upstream' }
    })
    await store.getState().fetchRepos()

    expect(store.getState().projects).not.toBe(projects)
    expect(store.getState().projects[0]?.gitRemoteIdentity?.remoteName).toBe('upstream')
  })

  it('treats clearing localWindowsRuntimePreference as a change', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    const projectId = store.getState().projects[0]!.id
    const withPreference: Project = {
      ...store.getState().projects[0]!,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    }
    store.setState({ projects: [withPreference] })

    await store.getState().fetchRepos()

    // Why: a local-host refresh is authoritative; an absent key must not read as unchanged.
    expect(store.getState().projects[0]).not.toBe(withPreference)
    expect(store.getState().projects[0]?.id).toBe(projectId)
    expect(store.getState().projects[0]?.localWindowsRuntimePreference).toBeUndefined()
  })

  it('reuses an unchanged setup element while a sibling changes', async () => {
    mockRepos(repo, secondRepo)
    const store = createTestStore()
    await store.getState().fetchRepos()
    const setups = store.getState().projectHostSetups
    expect(setups).toHaveLength(2)

    mockRepos(repo, { ...secondRepo, displayName: 'Repo 2 renamed' })
    await store.getState().fetchRepos()

    const next = store.getState().projectHostSetups
    expect(next).not.toBe(setups)
    expect(next[0]).toBe(setups[0])
    expect(next[1]).not.toBe(setups[1])
  })

  it('does not reuse a setup that moved to a different execution host', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    const setups = store.getState().projectHostSetups
    expect(setups[0]?.hostId).toBe('local')

    // Why: the repo-derived fallback sets setup.id = repo.id, so the same id on a second host is
    // the case that would silently splice the wrong host's routing metadata into the row.
    mockRepos({ ...repo, executionHostId: 'ssh:host-a', connectionId: 'host-a' })
    await store.getState().fetchRepos()

    const next = store.getState().projectHostSetups
    expect(next[0]).not.toBe(setups[0])
    expect(next[0]?.hostId).toBe('ssh:host-a')
  })

  it('reconciles both setups when one repo id exists on two hosts', async () => {
    // Why: the repo-derived fallback sets setup.id = repo.id, so these two setups share an id and
    // differ only by host. Keying the reconcile on setup.id instead of the owner key collapses them
    // onto one slot and one of the two churns on every refresh.
    const sshRepo: Repo = { ...repo, executionHostId: 'ssh:host-a', connectionId: 'host-a' }
    mockRepos(repo, sshRepo)
    const store = createTestStore()
    await store.getState().fetchRepos()
    const setups = store.getState().projectHostSetups
    expect(setups).toHaveLength(2)
    expect(new Set(setups.map((setup) => setup.id)).size).toBe(1)

    await store.getState().fetchRepos()

    expect(store.getState().projectHostSetups).toBe(setups)
    expect(store.getState().projectHostSetups[0]).toBe(setups[0])
    expect(store.getState().projectHostSetups[1]).toBe(setups[1])
  })

  it('drops a project and its setup when its repo disappears', async () => {
    mockRepos(repo, secondRepo)
    const store = createTestStore()
    await store.getState().fetchRepos()
    const projects = store.getState().projects

    mockRepos(repo)
    await store.getState().fetchRepos()

    expect(store.getState().projects).not.toBe(projects)
    expect(store.getState().projects).toHaveLength(1)
    expect(store.getState().projectHostSetups).toHaveLength(1)
  })

  it('adds a project and its setup when a repo appears', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    const projects = store.getState().projects

    mockRepos(repo, secondRepo)
    await store.getState().fetchRepos()

    expect(store.getState().projects).not.toBe(projects)
    expect(store.getState().projects).toHaveLength(2)
    expect(store.getState().projectHostSetups).toHaveLength(2)
  })

  it('keeps catalog identity when repo.addedAt is 0', async () => {
    mockRepos({ ...repo, addedAt: 0 })
    const store = createTestStore()
    await store.getState().fetchRepos()
    const projects = store.getState().projects
    const setups = store.getState().projectHostSetups
    expect(projects).toHaveLength(1)
    expect(setups).toHaveLength(1)
    expect(projects[0]?.createdAt).toBe(0)
    expect(setups[0]?.createdAt).toBe(0)

    await store.getState().fetchRepos()

    expect(store.getState().projects).toBe(projects)
    expect(store.getState().projects[0]).toBe(projects[0])
    expect(store.getState().projectHostSetups).toBe(setups)
    expect(store.getState().projectHostSetups[0]).toBe(setups[0])
  })

  it('keeps catalog identity when repo.addedAt is omitted', async () => {
    mockRepos(omitAddedAt(repo))
    const store = createTestStore()
    await store.getState().fetchRepos()
    const projects = store.getState().projects
    const setups = store.getState().projectHostSetups
    expect(projects).toHaveLength(1)
    expect(setups).toHaveLength(1)
    expect(projects[0]?.createdAt).toBe(0)
    expect(setups[0]?.createdAt).toBe(0)

    await store.getState().fetchRepos()

    expect(store.getState().projects).toBe(projects)
    expect(store.getState().projects[0]).toBe(projects[0])
    expect(store.getState().projectHostSetups).toBe(setups)
    expect(store.getState().projectHostSetups[0]).toBe(setups[0])
  })

  it('lets a nested hookSettings change through when repo.addedAt is 0', async () => {
    mockRepos({ ...repo, addedAt: 0 })
    const store = createTestStore()
    await store.getState().fetchRepos()
    const setups = store.getState().projectHostSetups

    mockRepos({
      ...repo,
      addedAt: 0,
      hookSettings: { mode: 'override', scripts: { setup: '', archive: '' } }
    })
    await store.getState().fetchRepos()

    expect(store.getState().projectHostSetups).not.toBe(setups)
    expect(store.getState().projectHostSetups[0]).not.toBe(setups[0])
    expect(store.getState().projectHostSetups[0]?.hookSettings?.mode).toBe('override')
  })
})

describe('repo filter identity across catalog refreshes', () => {
  it('keeps the filterRepoIds array when a refetch prunes nothing', async () => {
    const store = createTestStore()
    store.setState({ filterRepoIds: [repo.id] })
    const first = store.getState().filterRepoIds

    await store.getState().fetchRepos()

    // Why: App.tsx at the root and five sidebar consumers select this array by identity.
    expect(store.getState().filterRepoIds).toBe(first)
  })

  it('still prunes a filtered repo id that no longer exists', async () => {
    const store = createTestStore()
    store.setState({ filterRepoIds: [repo.id, 'gone'] })

    await store.getState().fetchRepos()

    expect(store.getState().filterRepoIds).toEqual([repo.id])
  })

  it('prunes only the vanished id and reallocates', async () => {
    mockRepos(repo)
    const store = createTestStore()
    store.setState({ filterRepoIds: [repo.id, secondRepo.id] })
    const first = store.getState().filterRepoIds

    await store.getState().fetchRepos()

    expect(store.getState().filterRepoIds).toEqual([repo.id])
    expect(store.getState().filterRepoIds).not.toBe(first)
  })

  it('keeps a filtered id whose repo merely moved to another host', async () => {
    const store = createTestStore()
    store.setState({ filterRepoIds: [repo.id] })
    const first = store.getState().filterRepoIds

    // Why: the filter is keyed on repo id, not host identity — a rehomed repo is not pruned.
    mockRepos({ ...repo, executionHostId: 'ssh:host-a', connectionId: 'host-a' })
    await store.getState().fetchRepos()

    expect(store.getState().filterRepoIds).toBe(first)
  })
})
describe('setup-script dismissal identity across catalog refreshes', () => {
  it('keeps the dismissal array when a refetch prunes nothing', async () => {
    const store = createTestStore()
    store.setState({
      setupScriptPromptDismissedRepoIds: [
        getSetupScriptPromptDismissalKey(getRepoHostIdentityForParts(repo.id, 'local'))
      ]
    })
    const first = store.getState().setupScriptPromptDismissedRepoIds

    await store.getState().fetchRepos()

    // Why: SetupScriptPromptCard Object.is-subscribes to this array. A no-op
    // catalog refresh must not allocate just because the helper rebuilt next.
    expect(store.getState().setupScriptPromptDismissedRepoIds).toBe(first)
  })
})

describe('SSH readoption catalog identity', () => {
  it('keeps projects and host setups across a no-op recordSshRepoReadoptions([])', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    const before = store.getState()
    const projects = before.projects
    const setups = before.projectHostSetups
    expect(projects).toHaveLength(1)
    expect(setups).toHaveLength(1)

    store.getState().recordSshRepoReadoptions([])

    // Why: the empty-in/empty-pending call must hand the state object back untouched, or the
    // freshly allocated pendingSshRepoReadoptions alone would wake every store subscriber.
    expect(store.getState()).toBe(before)
    expect(store.getState().pendingSshRepoReadoptions).toBe(before.pendingSshRepoReadoptions)
    expect(store.getState().projects).toBe(projects)
    expect(store.getState().projects[0]).toBe(projects[0])
    expect(store.getState().projectHostSetups).toBe(setups)
    expect(store.getState().projectHostSetups[0]).toBe(setups[0])
  })

  it('keeps catalog identity for a pending-only readoption while pending updates', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    const projects = store.getState().projects
    const setups = store.getState().projectHostSetups
    const readoption = { oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: [repo.id] }

    store.getState().recordSshRepoReadoptions([readoption])

    expect(store.getState().pendingSshRepoReadoptions).toEqual([readoption])
    expect(store.getState().projects).toBe(projects)
    expect(store.getState().projects[0]).toBe(projects[0])
    expect(store.getState().projectHostSetups).toBe(setups)
    expect(store.getState().projectHostSetups[0]).toBe(setups[0])
  })

  it('replaces the moved setup on a real prune/rehome', async () => {
    const oldHostRepo: Repo = {
      ...repo,
      connectionId: 'ssh-old',
      executionHostId: 'ssh:ssh-old'
    }
    const newHostRepo: Repo = {
      ...repo,
      connectionId: 'ssh-new',
      executionHostId: 'ssh:ssh-new'
    }
    mockRepos(oldHostRepo, newHostRepo)
    const store = createTestStore()
    await store.getState().fetchRepos()
    const setups = store.getState().projectHostSetups
    expect(setups).toHaveLength(2)
    const oldSetup = setups.find((setup) => setup.hostId === 'ssh:ssh-old')
    const newSetup = setups.find((setup) => setup.hostId === 'ssh:ssh-new')
    expect(oldSetup).toBeDefined()
    expect(newSetup).toBeDefined()

    store
      .getState()
      .recordSshRepoReadoptions([
        { oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: [repo.id] }
      ])

    const next = store.getState().projectHostSetups
    expect(next).not.toBe(setups)
    expect(next).toHaveLength(1)
    expect(next[0]).not.toBe(oldSetup)
    expect(next[0]?.hostId).toBe('ssh:ssh-new')
    expect(store.getState().repos).toHaveLength(1)
    expect(store.getState().repos[0]?.executionHostId).toBe('ssh:ssh-new')
    expect(store.getState().pendingSshRepoReadoptions).toEqual([])
  })
})
