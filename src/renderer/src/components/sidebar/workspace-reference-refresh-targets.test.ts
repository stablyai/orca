// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import { createVisibleHostedReviewRefreshScheduler } from '@/store/github/visible-hosted-review-refresh-scheduler'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { getWorkspaceReferenceRefreshTargets } from './workspace-reference-refresh-targets'
import {
  referenceAttachment,
  referenceRepo,
  referenceWorkspace,
  referenceReview
} from './workspace-reference-fixtures.test-support'
vi.mock('@/store', async () => {
  const browserWindow = globalThis.window
  const { createTestStore } = await import('@/store/slices/github-slice-test-harness')
  globalThis.window = browserWindow
  return { useAppStore: createTestStore() }
})
const read = vi.hoisted(() => vi.fn(async () => null))
vi.mock('./workspace-reference-detail-read', () => ({ readWorkspaceReferenceDetails: read }))
const workspace = { ...referenceWorkspace, linkedPR: null, linkedItems: [referenceAttachment()] }
const update = () => getWorkspaceReferenceRefreshTargets(useAppStore.getState())
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  useAppStore.setState({
    settings: null,
    repos: [referenceRepo],
    worktreesByRepo: { repo: [workspace] },
    detectedWorktreesByRepo: {},
    visibleReviewWorktreeIds: [workspace.id],
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all',
    hostedReviewCache: {},
    prCache: {},
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {
      [workspace.id]: [
        {
          id: 'browser',
          worktreeId: workspace.id,
          url: '',
          title: '',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    sshConnectionStates: new Map()
  })
})
afterEach(() => {
  vi.useRealTimers()
})
it('pauses disconnected SSH owners and only admits the owning reconnect', () => {
  useAppStore.setState({ repos: [{ ...referenceRepo, connectionId: 'ssh-a' }] })
  expect(update()).toEqual([])
  for (const [targetId, status, count] of [
    ['other', 'connected', 0],
    ['ssh-a', 'connected', 1],
    ['ssh-a', 'connecting', 0]
  ] as const) {
    useAppStore
      .getState()
      .sshConnectionStates.set(targetId, { targetId, status, error: null, reconnectAttempt: 0 })
    expect(update()).toHaveLength(count)
  }
})
it('shares one scheduler timer and removes queued work when the workspace leaves the viewport', async () => {
  useAppStore.setState({
    worktreesByRepo: {
      repo: [
        {
          ...workspace,
          linkedItems: Array.from({ length: 12 }, (_, i) => referenceAttachment(i + 1))
        }
      ]
    }
  })
  const scheduler = createVisibleHostedReviewRefreshScheduler()
  try {
    scheduler.update(update())
    scheduler.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(12)
    expect(vi.getTimerCount()).toBe(1)
    useAppStore.setState({ visibleReviewWorktreeIds: [] })
    scheduler.update(update())
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(read).toHaveBeenCalledTimes(12)
  } finally {
    scheduler.dispose()
  }
})
it('uses the known branch provider for sparse enterprise references', () => {
  const repo = {
    ...referenceRepo,
    gitRemoteIdentity: {
      canonicalKey: 'enterprise.test/acme/orca',
      remoteName: 'origin',
      remoteUrl: 'https://enterprise.test/acme/orca.git'
    }
  }
  const key = getHostedReviewCacheKey(repo.path, workspace.branch, null, repo.id, null, null, true)
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: {
      repo: [{ ...workspace, linkedItems: [{ provider: 'github', type: 'pr', number: 42 }] }]
    }
  })
  expect(update()).toHaveLength(0)
  useAppStore.setState({
    hostedReviewCache: { [key]: { data: referenceReview(), fetchedAt: Date.now() } }
  })
  expect(update()).toHaveLength(1)
})
it('retains both explicit owners when equal visible workspace IDs exist on two hosts', () => {
  const remoteRepo = {
    ...referenceRepo,
    executionHostId: 'ssh:remote' as const,
    connectionId: 'remote'
  }
  useAppStore.setState({
    repos: [referenceRepo, remoteRepo],
    worktreesByRepo: {
      local: [{ ...workspace, hostId: 'local' }],
      remote: [{ ...workspace, hostId: 'ssh:remote' }]
    },
    sshConnectionStates: new Map([
      ['remote', { targetId: 'remote', status: 'connected', error: null, reconnectAttempt: 0 }]
    ])
  })
  const targets = update()
  expect(targets).toHaveLength(2)
  expect(new Set(targets.map((target) => target.key)).size).toBe(2)
  useAppStore.setState({ visibleWorkspaceHostIds: ['local'] })
  expect(update()).toHaveLength(1)
  useAppStore.setState({
    activeWorktreeId: workspace.id,
    activeWorkspaceExecutionHostId: 'ssh:remote'
  })
  expect(
    getWorkspaceReferenceRefreshTargets(useAppStore.getState(), { selectedOnly: true })
  ).toHaveLength(1)
})

it('admits attached reviews on visible external detected worktrees', () => {
  useAppStore.setState({
    worktreesByRepo: {},
    detectedWorktreesByRepo: {
      repo: makeDetectedResult('repo', [workspace])
    }
  })
  expect(update()).toHaveLength(1)
})
