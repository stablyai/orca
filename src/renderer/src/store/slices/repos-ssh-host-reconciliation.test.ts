import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup, Repo, Worktree } from '../../../../shared/types'
import { createTestStore } from './store-test-helpers'

const repoId = 're-adopted-repo'
const projectId = `repo:${repoId}`

function directSshRepo(targetId: string): Repo {
  return {
    id: repoId,
    path: '/srv/repo',
    displayName: 'Re-adopted repo',
    badgeColor: '#000',
    addedAt: 1,
    connectionId: targetId,
    executionHostId: `ssh:${targetId}`
  }
}

function directSshSetup(targetId: string): ProjectHostSetup {
  return {
    id: `setup-${targetId}`,
    projectId,
    hostId: `ssh:${targetId}`,
    repoId,
    path: '/srv/repo',
    displayName: 'Re-adopted repo',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    connectionId: targetId,
    executionHostId: `ssh:${targetId}`
  }
}

function directSshWorktree(targetId: string, displayName = 'main'): Worktree {
  return {
    id: `${repoId}::/srv/repo`,
    repoId,
    hostId: `ssh:${targetId}`,
    path: '/srv/repo',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1
  }
}

const project: Project = {
  id: projectId,
  displayName: 'Re-adopted repo',
  badgeColor: '#000',
  sourceRepoIds: [repoId],
  createdAt: 1,
  updatedAt: 1
}

const reposList = vi.fn()
const projectsList = vi.fn()
const setupsList = vi.fn()
const worktreesListDetected = vi.fn()

beforeEach(() => {
  reposList.mockReset()
  projectsList.mockReset()
  setupsList.mockReset()
  worktreesListDetected.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups: setupsList },
      worktrees: { listDetected: worktreesListDetected }
    },
    dispatchEvent: vi.fn()
  })
})

describe('SSH repo host reconciliation', () => {
  const readoption = { oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: [repoId] }

  it('reconciles when repos:changed finishes before add-target evidence arrives', async () => {
    const staleRepo = directSshRepo('ssh-old')
    const liveRepo = directSshRepo('ssh-new')
    reposList.mockResolvedValue([liveRepo])
    projectsList.mockResolvedValue([project])
    setupsList.mockResolvedValue([directSshSetup('ssh-new')])
    const store = createTestStore()
    store.setState({
      repos: [staleRepo],
      projectHostSetups: [directSshSetup('ssh-old')],
      worktreesByRepo: {
        [repoId]: [
          directSshWorktree('ssh-old', 'stale'),
          directSshWorktree('ssh-new', 'authoritative')
        ]
      }
    })

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    expect(store.getState().repos).toEqual([staleRepo, liveRepo])

    store.getState().recordSshRepoReadoptions([readoption])

    expect(store.getState().repos).toEqual([liveRepo])
    expect(store.getState().projectHostSetups).toEqual([directSshSetup('ssh-new')])
    expect(store.getState().worktreesByRepo[repoId]).toEqual([
      directSshWorktree('ssh-new', 'authoritative')
    ])
  })

  it('keeps evidence pending until repos:changed delivers the new-host row', async () => {
    const liveRepo = directSshRepo('ssh-new')
    const runtimeSetup: ProjectHostSetup = {
      ...directSshSetup('ssh-runtime'),
      id: 'runtime-setup',
      hostId: 'runtime:env-1',
      executionHostId: 'runtime:env-1'
    }
    reposList.mockResolvedValue([liveRepo])
    projectsList.mockResolvedValue([project])
    setupsList.mockResolvedValue([directSshSetup('ssh-new')])
    const store = createTestStore()
    store.setState({
      repos: [directSshRepo('ssh-old')],
      projectHostSetups: [directSshSetup('ssh-old'), runtimeSetup]
    })

    store.getState().recordSshRepoReadoptions([readoption])
    expect(store.getState().repos).toEqual([directSshRepo('ssh-old')])
    expect(store.getState().pendingSshRepoReadoptions).toEqual([readoption])

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })

    expect(store.getState().repos).toEqual([liveRepo])
    expect(store.getState().projectHostSetups).toEqual(
      expect.arrayContaining([directSshSetup('ssh-new'), runtimeSetup])
    )
    expect(store.getState().projectHostSetups).toHaveLength(2)
    expect(store.getState().pendingSshRepoReadoptions).toEqual([])
  })

  it('drops an older all-host catalog that resolves after evidence is consumed', async () => {
    const staleRepo = directSshRepo('ssh-old')
    const liveRepo = directSshRepo('ssh-new')
    let resolveOldSetups!: (setups: ProjectHostSetup[]) => void
    let markOldSetupStarted!: () => void
    const oldSetups = new Promise<ProjectHostSetup[]>((resolve) => {
      resolveOldSetups = resolve
    })
    const oldSetupStarted = new Promise<void>((resolve) => {
      markOldSetupStarted = resolve
    })
    reposList.mockResolvedValueOnce([staleRepo]).mockResolvedValueOnce([liveRepo])
    projectsList.mockResolvedValue([project])
    setupsList
      .mockImplementationOnce(() => {
        markOldSetupStarted()
        return oldSetups
      })
      .mockResolvedValueOnce([directSshSetup('ssh-new')])
    const store = createTestStore()
    store.setState({ repos: [staleRepo], projectHostSetups: [directSshSetup('ssh-old')] })
    store.getState().recordSshRepoReadoptions([readoption])

    const olderFetch = store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    await oldSetupStarted
    const newerFetch = store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    await newerFetch
    resolveOldSetups([directSshSetup('ssh-old')])
    await olderFetch

    expect(store.getState().repos).toEqual([liveRepo])
    expect(store.getState().projectHostSetups).toEqual([directSshSetup('ssh-new')])
  })

  it('rejects an old-host worktree response that resolves after re-adoption', async () => {
    const staleWorktree = directSshWorktree('ssh-old', 'stale')
    let resolveOldWorktrees!: (value: unknown) => void
    const oldWorktrees = new Promise((resolve) => {
      resolveOldWorktrees = resolve
    })
    worktreesListDetected.mockReturnValueOnce(oldWorktrees)
    reposList.mockResolvedValue([directSshRepo('ssh-new')])
    projectsList.mockResolvedValue([project])
    setupsList.mockResolvedValue([directSshSetup('ssh-new')])
    const store = createTestStore()
    store.setState({
      repos: [directSshRepo('ssh-old')],
      worktreesByRepo: { [repoId]: [staleWorktree] },
      detectedWorktreesByRepo: {
        [repoId]: {
          repoId,
          authoritative: true,
          source: 'git',
          worktrees: [
            { ...staleWorktree, ownership: 'orca-managed', selectedCheckout: false, visible: true }
          ]
        }
      }
    })

    const staleFetch = store.getState().fetchWorktrees(repoId)
    await vi.waitFor(() => expect(worktreesListDetected).toHaveBeenCalled())
    store.getState().recordSshRepoReadoptions([readoption])
    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    resolveOldWorktrees({
      repoId,
      authoritative: true,
      source: 'git',
      worktrees: [
        { ...staleWorktree, ownership: 'orca-managed', selectedCheckout: false, visible: true }
      ]
    })
    await staleFetch

    expect(store.getState().worktreesByRepo[repoId]).toEqual([
      directSshWorktree('ssh-new', 'stale')
    ])
    expect(store.getState().detectedWorktreesByRepo[repoId].worktrees).toEqual([
      {
        ...directSshWorktree('ssh-new', 'stale'),
        ownership: 'orca-managed',
        selectedCheckout: false,
        visible: true
      }
    ])
  })

  it('rejects a worktree response after its final repo owner is removed', async () => {
    const staleWorktree = directSshWorktree('ssh-old', 'stale')
    let resolveOldWorktrees!: (value: unknown) => void
    const oldWorktrees = new Promise((resolve) => {
      resolveOldWorktrees = resolve
    })
    worktreesListDetected.mockReturnValueOnce(oldWorktrees)
    const store = createTestStore()
    store.setState({ repos: [directSshRepo('ssh-old')] })

    const staleFetch = store.getState().fetchWorktrees(repoId)
    await vi.waitFor(() => expect(worktreesListDetected).toHaveBeenCalled())
    store.setState({ repos: [], worktreesByRepo: {}, detectedWorktreesByRepo: {} })
    resolveOldWorktrees({
      repoId,
      authoritative: true,
      source: 'git',
      worktrees: [
        { ...staleWorktree, ownership: 'orca-managed', selectedCheckout: false, visible: true }
      ]
    })
    await staleFetch

    expect(store.getState().worktreesByRepo[repoId]).toBeUndefined()
    expect(store.getState().detectedWorktreesByRepo[repoId]).toBeUndefined()
  })

  it('preserves a forgettable SSH ghost when a local repo shares its UUID', async () => {
    const localRepo: Repo = {
      ...directSshRepo('ssh-old'),
      path: '/local/repo',
      connectionId: undefined,
      executionHostId: undefined
    }
    const oldRepo = directSshRepo('ssh-old')
    reposList.mockResolvedValue([localRepo, oldRepo])
    projectsList.mockResolvedValue([project])
    setupsList.mockResolvedValue([directSshSetup('ssh-old')])
    const store = createTestStore()
    store.setState({ repos: [localRepo, oldRepo], projectHostSetups: [directSshSetup('ssh-old')] })

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })

    expect(store.getState().repos).toEqual([{ ...localRepo, executionHostId: 'local' }, oldRepo])
    expect(store.getState().projectHostSetups).toEqual(
      expect.arrayContaining([directSshSetup('ssh-old')])
    )
    expect(store.getState().projectHostSetups).toHaveLength(2)
  })
})
