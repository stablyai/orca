import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { getHostedReviewCacheKey } from '../slices/hosted-review-cache-identity'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../slices/github-slice-test-harness'
import {
  getVisibleHostedReviewRefreshTargets,
  getVisibleHostedReviewWorkspaces,
  visibleHostedReviewRefreshInputsChanged
} from './visible-hosted-review-refresh-targets'
import { getWorkspaceReferenceRequest } from '@/components/sidebar/workspace-reference-details'
import { createVisibleHostedReviewRefreshScheduler } from './visible-hosted-review-refresh-scheduler'
import { refreshHostedReviewCard } from '../slices/hosted-review-card-refresh'

const repo: Repo = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }
const worktree = makePRRefreshWorktree()
const review: HostedReviewInfo = {
  provider: 'gitlab',
  number: 8,
  title: 'Review',
  state: 'open',
  status: 'success',
  url: 'https://example.com/review/8',
  updatedAt: '',
  mergeable: 'MERGEABLE'
}
const hostedKey = getHostedReviewCacheKey(
  repo.path,
  worktree.branch,
  null,
  repo.id,
  null,
  null,
  true
)
const prKey = `${repo.id}::${worktree.branch}`

function setup(owner: Repo = repo) {
  const store = createTestStore()
  store.setState({
    repos: [owner],
    settings: null,
    worktreesByRepo: { [repo.id]: [worktree] },
    activeWorktreeId: null,
    visibleReviewWorktreeIds: [worktree.id],
    sshConnectionStates: new Map()
  })
  return store
}

function targets(store: ReturnType<typeof setup>) {
  return getVisibleHostedReviewRefreshTargets(store.getState(), store.getState)
}

describe('visible hosted review refresh targets', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.hostedReview.forBranch.mockResolvedValue(review)
  })
  afterEach(() => vi.useRealTimers())

  it('discovers an unknown provider once and hands known local GitHub to main', async () => {
    const store = setup()
    mockApi.hostedReview.forBranch.mockResolvedValue({ ...review, provider: 'github' })
    expect(targets(store)).toHaveLength(1)
    expect(await targets(store)[0].refresh()).toBe(true)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)
    expect(targets(store)).toEqual([])
    expect(mockApi.gh.prForBranch).not.toHaveBeenCalled()
    store.setState({
      hostedReviewCache: {},
      prCache: { [prKey]: { data: null, fetchedAt: Date.now() } }
    })
    expect(targets(store)).toHaveLength(1)
  })

  it('preserves explicit non-GitHub linked hints despite a GitHub PR cache', async () => {
    const store = setup()
    store.setState({
      worktreesByRepo: { [repo.id]: [{ ...worktree, linkedGitLabMR: 8 }] },
      prCache: { [prKey]: { data: makePR(), fetchedAt: Date.now() } }
    })
    const rows = targets(store)
    expect(rows).toHaveLength(1)
    expect(await rows[0].refresh()).toBe(true)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwnerExecutionHostId: 'local',
        linkedGitLabMR: 8,
        force: true,
        currentHeadOid: worktree.head,
        admissionTier: 'background'
      })
    )
  })

  it.each([review, null])(
    'resolves a detached linked MR to a title or a settled miss: %j',
    async (result) => {
      const owner: Repo = {
        ...repo,
        gitRemoteIdentity: {
          canonicalKey: 'gitlab.example.com/team/repo',
          remoteName: 'origin',
          remoteUrl: 'https://gitlab.example.com/team/repo.git'
        }
      }
      const item = {
        provider: 'gitlab' as const,
        type: 'mr' as const,
        number: 8,
        url: 'https://gitlab.example.com/team/repo/-/merge_requests/8'
      }
      const detached = { ...worktree, branch: '', linkedGitLabMR: 8, linkedItems: [item] }
      const store = setup(owner)
      store.setState({ worktreesByRepo: { [repo.id]: [detached] }, activeWorktreeId: detached.id })
      mockApi.hostedReview.forBranch.mockResolvedValue(result)
      const exactKey = getWorkspaceReferenceRequest(item, detached, owner).key
      const rows = getVisibleHostedReviewRefreshTargets(store.getState(), store.getState, {
        selectedOnly: true
      })
      expect(rows).toHaveLength(1)
      expect(rows[0].key).toBe(exactKey)
      expect(await rows[0].refresh()).toBe(true)
      expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: '',
          linkedGitLabMR: 8,
          repoOwnerExecutionHostId: 'local',
          currentHeadOid: null
        })
      )
      expect(store.getState().hostedReviewCache[exactKey]?.data).toEqual(result)
      expect(mockApi.gh.prForBranch).not.toHaveBeenCalled()
    }
  )

  it('uses the repo runtime owner rather than the focused server and fills both caches', async () => {
    const owner: Repo = { ...repo, executionHostId: 'runtime:owner-server' }
    const store = setup(owner)
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'other-server' }),
      worktreesByRepo: { [repo.id]: [{ ...worktree, linkedPR: 12 }] },
      activeWorktreeId: worktree.id
    })
    runtimeEnvironmentCall.mockResolvedValue({ id: 'review', ok: true, result: makePR() })
    expect(await targets(store)[0].refresh()).toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'owner-server',
        method: 'github.prForBranch',
        params: expect.objectContaining({
          repo: repo.id,
          branch: worktree.branch,
          reason: 'visible',
          linkedPRNumber: 12
        })
      })
    )
    expect(mockApi.hostedReview.forBranch).not.toHaveBeenCalled()
    expect(store.getState().prCache[`runtime:owner-server::${prKey}`]?.data?.number).toBe(12)
    expect(
      store.getState().hostedReviewCache[`runtime:owner-server::${repo.id}::${worktree.branch}`]
        ?.data?.provider
    ).toBe('github')
  })

  it('routes non-GitHub runtime reviews and local reviews independently of server focus', async () => {
    const owner: Repo = { ...repo, executionHostId: 'runtime:owner-server' }
    const remote = setup(owner)
    runtimeEnvironmentCall.mockResolvedValue({ id: 'review', ok: true, result: review })
    expect(await targets(remote)[0].refresh()).toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'owner-server',
        method: 'hostedReview.forBranch'
      })
    )
    const local = setup()
    local.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'other-server' })
    })
    expect(await targets(local)[0].refresh()).toBe(true)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/repo', repoOwnerExecutionHostId: 'local' })
    )
  })

  it.each(
    (['github', 'gitlab'] as const).flatMap((provider) => [
      { provider, stamped: true },
      { provider, stamped: false }
    ])
  )(
    'selects a paired SSH workspace and refreshes $provider through its runtime owner (owner stamped: $stamped)',
    async ({ provider, stamped }) => {
      const owner: Repo = {
        ...repo,
        connectionId: 'builder',
        executionHostId: 'runtime:owner-server'
      }
      // Older paired listings named only the physical SSH host.
      const paired = {
        ...worktree,
        hostId: 'ssh:builder' as const,
        ...(stamped ? { runtimeOwnerEnvironmentId: 'owner-server' } : {}),
        ...(provider === 'github' ? { linkedPR: 12 } : { linkedGitLabMR: 8 })
      }
      const store = setup(owner)
      store.setState({
        repos: [repo, owner],
        worktreesByRepo: { [repo.id]: [{ ...worktree, hostId: 'local' }, paired] },
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: 'ssh:builder',
        visibleWorkspaceHostIds: ['ssh:builder'],
        sshConnectionStates: new Map([
          [
            'builder',
            { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }
          ]
        ])
      })
      const key = `runtime:owner-server::${repo.id}::${worktree.branch}`
      const selectedTargets = () =>
        getVisibleHostedReviewRefreshTargets(store.getState(), store.getState, {
          selectedOnly: true
        })
      expect(selectedTargets()).toMatchObject([{ key, selected: true }])
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'review',
        ok: true,
        result: provider === 'github' ? makePR() : review
      })
      expect(await selectedTargets()[0].refresh()).toBe(true)
      expect(store.getState().hostedReviewCache[key]?.data?.provider).toBe(provider)
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'owner-server',
          method: provider === 'github' ? 'github.prForBranch' : 'hostedReview.forBranch'
        })
      )
      expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
      expect(mockApi.hostedReview.forBranch).not.toHaveBeenCalled()

      store.setState({ activeWorkspaceExecutionHostId: 'runtime:owner-server' })
      expect(selectedTargets()).toMatchObject([{ key, selected: true }])
      store.setState({ activeWorkspaceExecutionHostId: 'local' })
      expect(selectedTargets().some((target) => target.key === key)).toBe(false)

      store.setState({ activeWorktreeId: null })
      expect(targets(store)).toMatchObject([{ key, selected: false }])
      store.setState({ visibleWorkspaceHostIds: null, workspaceHostScope: 'ssh:builder' })
      expect(targets(store)).toMatchObject([{ key, selected: false }])
      store.setState({ workspaceHostScope: 'runtime:other-server' })
      expect(targets(store)).toEqual([])
    }
  )

  it.each(['github', 'gitlab'] as const)(
    'refreshes both %s copies when direct SSH and runtime ownership share a physical host',
    async (provider) => {
      const direct: Repo = { ...repo, connectionId: 'builder' }
      const paired: Repo = { ...direct, executionHostId: 'runtime:owner-server' }
      const store = setup(direct)
      store.setState({
        repos: [paired, direct],
        worktreesByRepo: {
          [repo.id]: [
            {
              ...worktree,
              hostId: 'ssh:builder',
              runtimeOwnerEnvironmentId: 'owner-server',
              ...(provider === 'github' ? { linkedPR: 22 } : { linkedGitLabMR: 9 })
            },
            {
              ...worktree,
              hostId: 'ssh:builder',
              ...(provider === 'github' ? { linkedPR: 12 } : { linkedGitLabMR: 8 })
            }
          ]
        },
        sshConnectionStates: new Map([
          [
            'builder',
            { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }
          ]
        ])
      })
      mockApi.gh.refreshPRNow.mockResolvedValue({
        kind: 'found',
        pr: makePR({ number: 12 }),
        fetchedAt: Date.now()
      })
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'review',
        ok: true,
        result: provider === 'github' ? makePR({ number: 22 }) : { ...review, number: 9 }
      })

      const rows = targets(store)
      const directKey = `ssh:builder::${repo.id}::${worktree.branch}`
      const pairedKey = `runtime:owner-server::${repo.id}::${worktree.branch}`
      expect([...getVisibleHostedReviewWorkspaces(store.getState())]).toHaveLength(2)
      expect(rows.map((row) => row.key).sort()).toEqual(
        provider === 'github' ? [pairedKey] : [pairedKey, directKey].sort()
      )
      for (const row of rows) {
        expect(await row.refresh()).toBe(true)
      }
      if (provider === 'github') {
        await store.getState().fetchPRForBranch(repo.path, worktree.branch, {
          force: true,
          repoId: repo.id,
          repoOwnerExecutionHostId: 'ssh:builder',
          worktreeId: worktree.id,
          linkedPRNumber: 12
        })
      }
      expect(store.getState().hostedReviewCache[directKey]?.data?.number).toBe(
        provider === 'github' ? 12 : 8
      )
      expect(store.getState().hostedReviewCache[pairedKey]?.data?.number).toBe(
        provider === 'github' ? 22 : 9
      )
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'owner-server',
          method: provider === 'github' ? 'github.prForBranch' : 'hostedReview.forBranch'
        })
      )
      const directTransport =
        provider === 'github' ? mockApi.gh.refreshPRNow : mockApi.hostedReview.forBranch
      expect(directTransport).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    { activeHost: 'ssh:builder', focusedServer: null, selectedHost: 'ssh:builder' },
    {
      activeHost: 'runtime:owner-server',
      focusedServer: null,
      selectedHost: 'runtime:owner-server'
    },
    { activeHost: null, focusedServer: 'owner-server', selectedHost: 'runtime:owner-server' }
  ] as const)(
    'gives only the resolved $selectedHost copy foreground polling (active: $activeHost)',
    async ({ activeHost, focusedServer, selectedHost }) => {
      const direct: Repo = { ...repo, connectionId: 'builder' }
      const paired: Repo = { ...direct, executionHostId: 'runtime:owner-server' }
      const directKey = `ssh:builder::${repo.id}::${worktree.branch}`
      const pairedKey = `runtime:owner-server::${repo.id}::${worktree.branch}`
      const selectedKey = `${selectedHost}::${repo.id}::${worktree.branch}`
      const store = setup(direct)
      store.setState({
        repos: [paired, direct],
        worktreesByRepo: {
          [repo.id]: [
            { ...worktree, hostId: 'ssh:builder', linkedGitLabMR: 8 },
            {
              ...worktree,
              hostId: 'ssh:builder',
              runtimeOwnerEnvironmentId: 'owner-server',
              linkedGitLabMR: 9
            }
          ]
        },
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: activeHost,
        settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: focusedServer }),
        hostedReviewCache: {
          [directKey]: { data: review, fetchedAt: Date.now() },
          [pairedKey]: { data: { ...review, number: 9 }, fetchedAt: Date.now() }
        },
        sshConnectionStates: new Map([
          [
            'builder',
            { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }
          ]
        ])
      })

      const rows = targets(store)
      expect(rows).toHaveLength(2)
      expect(rows.filter((row) => row.selected).map((row) => row.key)).toEqual([selectedKey])
      runtimeEnvironmentCall.mockResolvedValue({ id: 'review', ok: true, result: review })
      for (const row of rows) {
        expect(row.intervalMs).toBe(row.key === selectedKey ? 60_000 : 120_000)
        await row.refresh()
      }
      expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          admissionTier: selectedHost === 'ssh:builder' ? 'interactive' : 'background'
        })
      )
      expect(mockApi.hostedReview.forBranch.mock.lastCall?.[0]).toEqual(
        selectedHost === 'ssh:builder'
          ? expect.objectContaining({ active: true })
          : expect.not.objectContaining({ active: true })
      )
      expect(
        getVisibleHostedReviewRefreshTargets(store.getState(), store.getState, {
          selectedOnly: true
        }).map((row) => row.key)
      ).toEqual([selectedKey])
      store.setState({ visibleWorkspaceHostIds: ['local'] })
      expect(targets(store).map((row) => row.key)).toEqual([selectedKey])
      store.setState({ visibleWorkspaceHostIds: [selectedHost] })
      expect(targets(store).map((row) => row.key)).toEqual(
        selectedHost === 'ssh:builder' ? [directKey, pairedKey] : [pairedKey]
      )
    }
  )

  it.each(['ssh:builder', 'runtime:owner-server'] as const)(
    'rejects duplicate explicit %s worktree owners while retaining the other copy',
    (hostId) => {
      const direct: Repo = { ...repo, connectionId: 'builder' }
      const store = setup(direct)
      const directWorktree = { ...worktree, hostId: 'ssh:builder' as const, linkedGitLabMR: 8 }
      const pairedWorktree = { ...directWorktree, runtimeOwnerEnvironmentId: 'owner-server' }
      store.setState({
        repos: [direct, { ...direct, executionHostId: 'runtime:owner-server' }],
        worktreesByRepo: {
          [repo.id]: [
            directWorktree,
            pairedWorktree,
            { ...(hostId === 'ssh:builder' ? directWorktree : pairedWorktree) }
          ]
        },
        sshConnectionStates: new Map([
          [
            'builder',
            { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }
          ]
        ])
      })
      const otherHostId = hostId === 'ssh:builder' ? 'runtime:owner-server' : 'ssh:builder'
      expect(targets(store).map((row) => row.key)).toEqual([
        `${otherHostId}::${repo.id}::${worktree.branch}`
      ])
    }
  )

  it('rejects an older paired SSH workspace that rival servers both proxy', () => {
    const first: Repo = { ...repo, connectionId: 'builder', executionHostId: 'runtime:first' }
    const store = setup(first)
    store.setState({
      repos: [first, { ...first, executionHostId: 'runtime:second' }],
      worktreesByRepo: { [repo.id]: [{ ...worktree, hostId: 'ssh:builder', linkedPR: 12 }] },
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: 'ssh:builder',
      sshConnectionStates: new Map([
        ['builder', { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }]
      ])
    })
    expect(targets(store)).toEqual([])
    store.getState().refreshGitHubForWorktree(worktree.id, 'runtime:first')
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
  })

  it('keeps an older SSH workspace on its direct repo when a server also proxies it', async () => {
    const direct: Repo = { ...repo, connectionId: 'builder' }
    const store = setup(direct)
    store.setState({
      repos: [{ ...direct, executionHostId: 'runtime:owner-server' }, direct],
      worktreesByRepo: { [repo.id]: [{ ...worktree, hostId: 'ssh:builder' }] },
      sshConnectionStates: new Map([
        ['builder', { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }]
      ])
    })
    const rows = targets(store)
    expect(rows.map((row) => row.key)).toEqual([`ssh:builder::${repo.id}::${worktree.branch}`])
    await rows[0].refresh()
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith(
      expect.objectContaining({ repoOwnerExecutionHostId: 'ssh:builder' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('excludes folders, bare, archived, detached, missing and disconnected SSH workspaces', () => {
    const store = setup()
    store.setState({ repos: [{ ...repo, kind: 'folder' }] })
    expect(targets(store)).toEqual([])
    store.setState({ repos: [repo] })
    for (const patch of [
      { isBare: true },
      { isArchived: true },
      { branch: '' },
      { branch: 'HEAD' }
    ]) {
      store.setState({ worktreesByRepo: { [repo.id]: [{ ...worktree, ...patch }] } })
      expect(targets(store)).toEqual([])
    }
    store.setState({
      worktreesByRepo: { [repo.id]: [worktree] },
      visibleReviewWorktreeIds: ['missing']
    })
    expect(targets(store)).toEqual([])
    store.setState({
      repos: [{ ...repo, connectionId: 'ssh-1' }],
      visibleReviewWorktreeIds: [worktree.id]
    })
    expect(targets(store)).toEqual([])
  })

  it('shares host/repo/branch aliases and promotes the selected alias', async () => {
    const store = setup()
    const alias = { ...worktree, id: 'alias' }
    store.setState({
      worktreesByRepo: { [repo.id]: [worktree, alias] },
      visibleReviewWorktreeIds: [worktree.id, alias.id],
      activeWorktreeId: alias.id,
      hostedReviewCache: { [hostedKey]: { data: review, fetchedAt: Date.now() } }
    })
    const rows = targets(store)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ intervalMs: 60_000, selected: true })
    await rows[0].refresh()
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith(
      expect.objectContaining({ active: true })
    )
    const revision = rows[0].revision
    store.setState({ visibleReviewWorktreeIds: [alias.id, worktree.id] })
    expect(targets(store)[0].revision).toBe(revision)
    store.setState({ worktreesByRepo: { [repo.id]: [{ ...worktree, head: 'new-head' }, alias] } })
    expect(targets(store)[0].revision).not.toBe(revision)
  })

  // E9: the timer-driven refresh of the selected card is interactive for priority, not a user act.
  it('never asks to start a stopped WSL distro for the selected card, while a manual Refresh does', async () => {
    const store = setup()
    store.setState({ activeWorktreeId: worktree.id })
    const rows = targets(store)
    expect(rows[0]).toMatchObject({ selected: true })
    await rows[0].refresh()
    expect(mockApi.hostedReview.forBranch).toHaveBeenLastCalledWith(
      expect.objectContaining({ admissionTier: 'interactive', active: true })
    )
    expect(mockApi.hostedReview.forBranch.mock.lastCall?.[0]).not.toHaveProperty('wakeWslDistro')

    await refreshHostedReviewCard(store.getState().fetchHostedReviewForBranch, {
      repoPath: repo.path,
      repoId: repo.id,
      branch: worktree.branch,
      admissionTier: 'interactive'
    })
    expect(mockApi.hostedReview.forBranch).toHaveBeenLastCalledWith(
      expect.objectContaining({ admissionTier: 'interactive', wakeWslDistro: true })
    )
  })

  it('sets provider-neutral cadence for open, no review, closed and merged states', () => {
    const store = setup()
    for (const provider of ['gitlab', 'bitbucket', 'azure-devops', 'gitea'] as const) {
      for (const [state, status, intervalMs] of [
        ['open', 'success', 120_000],
        ['draft', 'pending', 120_000],
        ['closed', 'failure', 900_000],
        ['merged', 'pending', 60_000],
        ['merged', 'success', null],
        ['merged', 'failure', null],
        ['merged', 'neutral', null]
      ] as const) {
        store.setState({
          hostedReviewCache: {
            [hostedKey]: { data: { ...review, provider, state, status }, fetchedAt: Date.now() }
          }
        })
        expect(targets(store)[0].intervalMs).toBe(intervalMs)
      }
    }
    store.setState({ hostedReviewCache: { [hostedKey]: { data: null, fetchedAt: Date.now() } } })
    expect(targets(store)[0].intervalMs).toBe(900_000)
    store.setState({ activeWorktreeId: worktree.id })
    expect(targets(store)[0].intervalMs).toBe(60_000)
  })

  it('detects preserved hosted cache failures and backs off without blanking the review', async () => {
    const store = setup()
    store.setState({
      hostedReviewCache: { [hostedKey]: { data: review, fetchedAt: Date.now() - 120_000 } }
    })
    mockApi.hostedReview.forBranch.mockRejectedValue(new Error('temporary failure'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scheduler = createVisibleHostedReviewRefreshScheduler()
    const unsubscribe = store.subscribe((state, previous) => {
      if (visibleHostedReviewRefreshInputsChanged(state, previous)) {
        scheduler.update(targets(store))
      }
    })
    scheduler.update(targets(store))
    scheduler.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)
    expect(store.getState().hostedReviewCache[hostedKey].data).toEqual(review)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
    scheduler.dispose()
    unsubscribe()
    log.mockRestore()
  })

  it('ignores unrelated store writes and includes every projection input', () => {
    const store = setup()
    const state = store.getState()
    expect(
      visibleHostedReviewRefreshInputsChanged({ ...state, prVisibleRefreshGeneration: 5 }, state)
    ).toBe(false)
    expect(
      visibleHostedReviewRefreshInputsChanged({ ...state, activeWorktreeId: worktree.id }, state)
    ).toBe(true)
    expect(
      visibleHostedReviewRefreshInputsChanged({ ...state, hostedReviewCache: {} }, state)
    ).toBe(true)
  })

  it('keeps positive GitHub ownership after a miss and trusts known GitHub remote identity', () => {
    const store = setup()
    store.setState({
      hostedReviewCache: {
        [hostedKey]: { data: null, fetchedAt: Date.now(), linkedReviewHintKey: 'github:12' }
      }
    })
    expect(targets(store)).toEqual([])
    store.setState({
      hostedReviewCache: {},
      repos: [
        {
          ...repo,
          gitRemoteIdentity: {
            canonicalKey: 'github.com/team/repo',
            remoteName: 'origin',
            remoteUrl: 'git@github.com:team/repo.git'
          }
        }
      ]
    })
    expect(targets(store)).toEqual([])
    store.setState({ hostedReviewCache: { [hostedKey]: { data: review, fetchedAt: Date.now() } } })
    expect(targets(store)).toHaveLength(1)
  })

  it('requires discovery for a changed runtime HEAD even with fresh settled merged metadata', () => {
    const store = setup({ ...repo, executionHostId: 'runtime:owner-server' })
    store.setState({
      prCache: {
        [`runtime:owner-server::${prKey}`]: {
          data: makePR({ state: 'merged', checksStatus: 'success' }),
          fetchedAt: Date.now(),
          fetchedHeadOid: 'older-head'
        }
      }
    })
    expect(targets(store)[0]).toMatchObject({ fetchedAt: null, intervalMs: null })
  })

  it('discovers a changed runtime HEAD from persisted metadata without a recorded request HEAD', () => {
    const store = setup({ ...repo, executionHostId: 'runtime:owner-server' })
    store.setState({
      prCache: {
        [`runtime:owner-server::${prKey}`]: {
          data: makePR({ state: 'merged', checksStatus: 'success', headSha: 'older-head' }),
          fetchedAt: Date.now()
        }
      }
    })
    expect(targets(store)[0]).toMatchObject({ fetchedAt: null, intervalMs: null })
    store.setState({
      prCache: {
        [`runtime:owner-server::${prKey}`]: {
          data: makePR({ state: 'merged', checksStatus: 'success', headSha: 'older-head' }),
          fetchedAt: Date.now(),
          fetchedHeadOid: worktree.head
        }
      }
    })
    expect(targets(store)[0]).toMatchObject({ fetchedAt: Date.now(), intervalMs: null })
  })

  it.each([
    { head: '', headSha: 'older-head' },
    { head: worktree.head, headSha: '' }
  ])('preserves fresh settled metadata with an unknown HEAD: %j', ({ head, headSha }) => {
    const store = setup({ ...repo, executionHostId: 'runtime:owner-server' })
    store.setState({
      worktreesByRepo: { [repo.id]: [{ ...worktree, head }] },
      prCache: {
        [`runtime:owner-server::${prKey}`]: {
          data: makePR({ state: 'merged', checksStatus: 'success', headSha }),
          fetchedAt: Date.now()
        }
      }
    })
    expect(targets(store)[0]).toMatchObject({ fetchedAt: Date.now(), intervalMs: null })
  })

  it('includes only connected SSH branches and preserves their host scope', async () => {
    const store = setup({ ...repo, connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' })
    store.setState({
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0
          }
        ]
      ])
    })
    const rows = targets(store)
    expect(rows[0].key).toBe(`ssh:ssh-1::${repo.id}::${worktree.branch}`)
    await rows[0].refresh()
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith(
      expect.objectContaining({ repoOwnerExecutionHostId: 'ssh:ssh-1' })
    )
  })

  it('limits paired-web card metadata to the selected workspace while preserving discovery', async () => {
    const store = setup()
    store.setState({
      activeWorktreeId: worktree.id,
      visibleReviewWorktreeIds: [worktree.id, 'other'],
      worktreesByRepo: { [repo.id]: [worktree, { ...worktree, id: 'other', branch: 'other' }] }
    })
    const selected = getVisibleHostedReviewRefreshTargets(store.getState(), store.getState, {
      selectedOnly: true
    })
    expect(selected).toHaveLength(1)
    expect(selected[0].selected).toBe(true)
    store.setState({ activeWorktreeId: null })
    expect(
      getVisibleHostedReviewRefreshTargets(store.getState(), store.getState, { selectedOnly: true })
    ).toEqual([])
  })

  it('retains selection for a workspace published only in the detected catalog', () => {
    const store = setup()
    store.setState({
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: {},
      detectedWorktreesByRepo: {
        [repo.id]: {
          repoId: repo.id,
          authoritative: true,
          source: 'git',
          worktrees: [{ ...worktree, ownership: 'external', selectedCheckout: true, visible: true }]
        }
      }
    })
    expect(
      [...getVisibleHostedReviewWorkspaces(store.getState(), { selectedOnly: true })].map(
        ({ worktree, selected }) => ({ id: worktree.id, selected })
      )
    ).toEqual([{ id: worktree.id, selected: true }])
  })

  it.each<Partial<AppState>>([
    { activeWorkspaceExecutionHostId: 'ssh:other' },
    { visibleWorkspaceHostIds: ['local'] },
    { workspaceHostScope: 'local' }
  ])('updates reference demand when owner visibility changes: %j', (patch) => {
    const store = setup()
    const previous = store.getState()
    const next = { ...previous, ...patch }
    expect(visibleHostedReviewRefreshInputsChanged(next, previous)).toBe(true)
  })

  it('refreshes the selected runtime copy when repository and worktree IDs collide', async () => {
    const first: Repo = {
      ...repo,
      executionHostId: 'runtime:first',
      gitRemoteIdentity: {
        canonicalKey: 'github.com/acme/orca',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/acme/orca.git'
      }
    }
    const second: Repo = { ...first, executionHostId: 'runtime:second' }
    const store = setup(first)
    store.setState({
      repos: [first, second],
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: 'runtime:second',
      worktreesByRepo: {
        first: [{ ...worktree, hostId: 'runtime:first' }],
        second: [{ ...worktree, hostId: 'runtime:second' }]
      }
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'pr-second',
      ok: true,
      result: makePR({ number: 26 }),
      _meta: { runtimeId: 'second' }
    })
    const selected = getVisibleHostedReviewRefreshTargets(store.getState(), store.getState, {
      selectedOnly: true
    })
    expect(selected).toHaveLength(1)
    expect(await selected[0].refresh()).toBe(true)
    expect(store.getState().prCache[`runtime:second::${prKey}`]?.data?.number).toBe(26)
    expect(store.getState().prCache[`runtime:first::${prKey}`]).toBeUndefined()
    expect(mockApi.gh.prForBranch).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'second' })
    )
  })

  it('lets normal hosted-review refreshes share the host cache but forces discovery', async () => {
    const store = setup()
    await targets(store)[0].refresh(false)
    expect(mockApi.hostedReview.forBranch).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ force: true })
    )
    await targets(store)[0].refresh(true)
    expect(mockApi.hostedReview.forBranch).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true })
    )
  })
})
