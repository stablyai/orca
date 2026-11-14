import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PRDetailRecoveryCommitArgs,
  PRDetailRecoveryStartArgs
} from '../../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'

// Host modules load by computed path so the web typecheck project stays free of main-process code.
type HostModule = Record<string, (...args: unknown[]) => unknown>
const loadHost = (path: string): Promise<HostModule> =>
  import(/* @vite-ignore */ `../../../../../main/github/${path}`)

const { coordinatorMocks, moduleMocks, getPRForBranchOutcomeMock } = await vi.hoisted(async () => {
  const mocksPath =
    '../../../../../main/github/pull-requests/refresh/pr-refresh-coordinator-test-mocks'
  const moduleMocks: HostModule = await import(/* @vite-ignore */ mocksPath)
  const coordinatorMocks: unknown = moduleMocks.createPRRefreshCoordinatorMocks()
  const provider =
    typeof coordinatorMocks === 'object' &&
    coordinatorMocks !== null &&
    'getPRForBranchOutcomeMock' in coordinatorMocks
      ? coordinatorMocks.getPRForBranchOutcomeMock
      : null
  if (!vi.isMockFunction(provider)) {
    throw new Error('PR refresh coordinator mocks changed shape')
  }
  return { coordinatorMocks, moduleMocks, getPRForBranchOutcomeMock: provider }
})

vi.mock('../../../../../main/github/pull-requests/refresh/pr-refresh-renderer-port', () =>
  Object.assign({}, moduleMocks.rendererPortModuleMock(coordinatorMocks))
)
vi.mock('../../../../../main/github/client/lookup/pr-for-branch-outcome', () =>
  Object.assign({}, moduleMocks.clientModuleMock(coordinatorMocks))
)
vi.mock('../../../../../main/github/repositories/github-api-repository-remote-probe', () =>
  Object.assign({}, moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks))
)
vi.mock('../../../../../main/github/api/rate-limit', () =>
  Object.assign({}, moduleMocks.rateLimitModuleMock(coordinatorMocks))
)

import { notePRLookupIntent } from '../requests/request-coordination'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi
} from '../github-slice-test-harness'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { getGitHubRepoCacheKey } from '../../../../../shared/github/cache/github-cache-key'

// The coordinator test reset pins fake time here.
const START_AT = 1_000
const repo = { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: 'blue', addedAt: 1 }
const worktree = makePRRefreshWorktree({ id: 'wt-1', branch: 'feature/test', head: 'h2' })
const context = {
  worktreeId: 'wt-1',
  repoId: 'repo-1',
  repoPath: '/repo',
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  branch: 'feature/test',
  headOid: 'h2',
  linkedPRNumber: null,
  hintPRNumber: 7,
  hostedReviewCacheKey: 'hosted::/repo::feature/test',
  selectionRevision: '|||||'
}

const bridge: {
  starts: unknown[]
  loseNextStartReply: boolean
  startReply: ((snapshot: unknown) => Promise<unknown>) | null
  directGate: Promise<void> | null
  host: HostModule
  coordinator: HostModule
} = {
  starts: [],
  loseNextStartReply: false,
  startReply: null,
  directGate: null,
  host: {},
  coordinator: {}
}

function ticketIdOf(snapshot: unknown): string {
  return typeof snapshot === 'object' && snapshot !== null && 'ticketId' in snapshot
    ? String(snapshot.ticketId)
    : ''
}

/** The native preload bridge, reaching the real host coordinator and drainer in-process. */
async function connectNativeBridge(): Promise<void> {
  const host = await loadHost('pull-requests/refresh/pr-detail-recovery-coordinator')
  const { prDetailRecoveryCandidate } = await loadHost(
    'pull-requests/refresh/pr-detail-recovery-candidate'
  )
  const coordinator = await loadHost('pull-requests/refresh/pr-refresh-coordinator')
  Object.assign(bridge, {
    starts: [],
    loseNextStartReply: false,
    startReply: null,
    directGate: null,
    host,
    coordinator
  })
  const callerKey = 'ipc:1'
  mockApi.gh.refreshPRNow.mockImplementation(async (args) => {
    // A delayed host notice: the direct read reaches the host only when the gate opens.
    await bridge.directGate
    return coordinator.refreshPRNow(args.candidate, args.reason)
  })
  Object.assign(mockApi.gh, {
    startPRDetailRecovery: async (args: PRDetailRecoveryStartArgs) => {
      const snapshot = host.startPRDetailRecovery(
        { callerKey, windowId: 1 },
        args,
        prDetailRecoveryCandidate(args) ?? 'validation'
      )
      bridge.starts.push(snapshot)
      if (bridge.loseNextStartReply) {
        bridge.loseNextStartReply = false
        throw new Error('reply lost after the host accepted the start')
      }
      return bridge.startReply ? bridge.startReply(snapshot) : snapshot
    },
    waitPRDetailRecovery: (args: { ticketId: string; afterRevision: number }) =>
      host.waitPRDetailRecovery(callerKey, args.ticketId, args.afterRevision),
    commitPRDetailRecovery: async (args: PRDetailRecoveryCommitArgs) =>
      host.commitPRDetailRecovery(callerKey, args),
    cancelPRDetailRecovery: async (args: { ticketId: string }) =>
      host.cancelPRDetailRecovery(callerKey, args.ticketId)
  })
}

function hostSnapshot(snapshot: unknown): Promise<unknown> {
  return Promise.resolve(bridge.host.waitPRDetailRecovery('ipc:1', ticketIdOf(snapshot), -1))
}

const alias = {
  cacheKey: '',
  repoId: 'repo-1',
  repoPath: '/repo',
  branch: 'feature/test',
  worktreeId: 'wt-1',
  connectionId: null,
  currentHeadOid: 'h2'
}

function setup() {
  const store = createTestStore()
  // Recovery subscription state is per renderer; start each case from a hidden panel.
  store.getState().notePRDetailRecoveryPanelVisible(false)
  store.setState({ repos: [repo], worktreesByRepo: { 'repo-1': [worktree] } })
  const cacheKey = getGitHubRepoCacheKey(
    '/repo',
    'repo-1',
    'feature/test',
    store.getState().settings,
    undefined,
    undefined,
    true
  )
  return { store, cacheKey }
}

describe('Checks detail recovery through the host coordinator', () => {
  beforeEach(async () => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    await connectNativeBridge()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes the current-HEAD read through the guarded writer once per exposure', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ number: 8, url: 'https://github.com/acme/widgets/pull/8', headSha: 'h2' }),
      fetchedAt: START_AT
    })
    const { store, cacheKey } = setup()
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(getPRForBranchOutcomeMock.mock.calls[0][4]).toBe(7)
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(8)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'resolved' })

    store.getState().reconcileGitHubPRDetails(null)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('reports an unusable read without retrying it in the same exposure', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: START_AT })
    const { store } = setup()
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'unusable' })
    expect(store.getState().prDetailRecovery?.terminalCount).toBe(1)

    store.getState().reconcileGitHubPRDetails({ ...context })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    store.getState().notePRDetailRecoveryPanelVisible(false)
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('waits for an in-flight direct read before submitting, then reads once', async () => {
    const direct = Promise.withResolvers<{ kind: 'no-pr'; fetchedAt: number }>()
    getPRForBranchOutcomeMock
      .mockReturnValueOnce(direct.promise)
      .mockResolvedValue({ kind: 'no-pr', fetchedAt: START_AT })
    const { store } = setup()
    store.getState().notePRDetailRecoveryPanelVisible(true)
    void store.getState().fetchPRForBranch('/repo', 'feature/test', {
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      force: true
    })
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'waiting' })

    direct.resolve({ kind: 'no-pr', fetchedAt: START_AT })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(getPRForBranchOutcomeMock.mock.calls[1][4]).toBe(7)
  })

  it('lets a newer direct read win over a late recovery result', async () => {
    const recovery = Promise.withResolvers<unknown>()
    getPRForBranchOutcomeMock.mockReturnValueOnce(recovery.promise).mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ number: 9, headSha: 'h2' }),
      fetchedAt: START_AT
    })
    const { store, cacheKey } = setup()
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'admitted' })

    await store.getState().fetchPRForBranch('/repo', 'feature/test', {
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      force: true,
      userRefresh: true
    })
    recovery.resolve({
      kind: 'found',
      pr: makePR({ number: 8, headSha: 'h2' }),
      fetchedAt: START_AT
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(9)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'closed' })
  })

  it('yields to a newer local direct lookup whose host notice has not arrived', async () => {
    const predecessor = Promise.withResolvers<unknown>()
    getPRForBranchOutcomeMock.mockReturnValueOnce(predecessor.promise).mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ number: 9, headSha: 'h2' }),
      fetchedAt: START_AT
    })
    const { store, cacheKey } = setup()
    bridge.coordinator.enqueuePRRefresh(
      { ...alias, cacheKey, repoKind: 'git', linkedPRNumber: null },
      'active',
      80,
      1
    )
    await vi.advanceTimersByTimeAsync(0)
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.starts).toHaveLength(1)

    const gate = Promise.withResolvers<void>()
    bridge.directGate = gate.promise
    const direct = store.getState().fetchPRForBranch('/repo', 'feature/test', {
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      force: true,
      userRefresh: true
    })
    predecessor.resolve({ kind: 'no-pr', fetchedAt: START_AT })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await hostSnapshot(bridge.starts[0])).toMatchObject({
      admitted: false,
      terminal: { kind: 'cancelled' }
    })
    expect(await hostSnapshot(bridge.starts[0])).not.toHaveProperty('publicationGrantId')
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    gate.resolve()
    await direct
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(9)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'closed' })
  })

  it('resumes the same epoch after a lost start reply without a second read', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ number: 8, headSha: 'h2' }),
      fetchedAt: START_AT
    })
    const { store, cacheKey } = setup()
    bridge.loseNextStartReply = true
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(bridge.starts.map(ticketIdOf)).toEqual([
      ticketIdOf(bridge.starts[0]),
      ticketIdOf(bridge.starts[0])
    ])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(8)
  })

  it('does not resume a lost start once its context changed, and the orphan never reads', async () => {
    const { store } = setup()
    bridge.loseNextStartReply = true
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(500)
    store.setState({ worktreesByRepo: { 'repo-1': [{ ...worktree, head: 'h3' }] } })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(bridge.starts).toHaveLength(1)
    expect(await hostSnapshot(bridge.starts[0])).toMatchObject({
      terminal: { kind: 'not-admitted', reason: 'prepare-expired' }
    })
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })

  it('keeps a published recovery result over a late older event, and yields to a newer one', async () => {
    const recovery = Promise.withResolvers<unknown>()
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ number: 8, headSha: 'h2' }),
        fetchedAt: START_AT
      })
      .mockReturnValueOnce(recovery.promise)
    const { store, cacheKey } = setup()
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(8)
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 0,
      reason: 'active',
      aliases: [{ ...alias, cacheKey }],
      outcome: { kind: 'no-pr', fetchedAt: START_AT }
    })
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(8)

    // New exposure: an event newer than the recovery read lands first and wins.
    store.getState().notePRDetailRecoveryPanelVisible(false)
    store.setState({ prCache: {} })
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'admitted' })
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1_000_000,
      reason: 'active',
      aliases: [{ ...alias, cacheKey }],
      outcome: { kind: 'found', pr: makePR({ number: 9, headSha: 'h2' }), fetchedAt: START_AT + 1 }
    })
    recovery.resolve({
      kind: 'found',
      pr: makePR({ number: 8, headSha: 'h2' }),
      fetchedAt: START_AT
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(9)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'closed' })
  })

  it('keeps its alias fence while unrelated aliases saturate the intent map', async () => {
    const predecessor = Promise.withResolvers<unknown>()
    const recovery = Promise.withResolvers<unknown>()
    getPRForBranchOutcomeMock
      .mockReturnValueOnce(predecessor.promise)
      .mockReturnValueOnce(recovery.promise)
    const { store, cacheKey } = setup()
    bridge.coordinator.enqueuePRRefresh(
      { ...alias, cacheKey, repoKind: 'git', linkedPRNumber: null },
      'active',
      80,
      1
    )
    await vi.advanceTimersByTimeAsync(0)
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 1_100; index += 1) {
      notePRLookupIntent(`unrelated-pending-${index}`)
    }
    predecessor.resolve({ kind: 'no-pr', fetchedAt: START_AT })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'admitted' })

    for (let index = 0; index < 1_100; index += 1) {
      notePRLookupIntent(`unrelated-granted-${index}`)
    }
    recovery.resolve({
      kind: 'found',
      pr: makePR({ number: 8, headSha: 'h2' }),
      fetchedAt: START_AT
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(8)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'resolved' })
  })

  it('bounds a native start that never answers and ignores its late reply', async () => {
    const late = Promise.withResolvers<void>()
    bridge.startReply = async (snapshot) => {
      await late.promise
      return snapshot
    }
    const { store } = setup()
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(70_000)
    expect(bridge.starts).toHaveLength(3)
    expect(new Set(bridge.starts.map(ticketIdOf)).size).toBe(1)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'failed' })

    store.getState().notePRDetailRecoveryPanelVisible(false)
    late.resolve()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.getState().prDetailRecovery).toBeNull()
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })
})
