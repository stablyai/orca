import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from '../github-slice-test-harness'
import { setLocalRuntimeCapabilitiesForTests } from '../../../runtime/local-runtime-capabilities'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as capability } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import { isCompletePRCheckOwner } from '../../../../../shared/github/complete-pr-check-owner'
import { createCompatibleRuntimeStatusResponse } from '../../../runtime/runtime-compatibility-test-fixture'
import { getOverallCheckCounts } from '../../../components/pr-check-counts'

const repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 1,
  kind: 'git' as const
}
const prRepo = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const now = 1_800_000_000_000
const branch = 'feature/checks'
const cacheKey = `${repo.id}::${branch}`
const successfulRows: PRCheckDetail[] = [
  { name: 'Build', status: 'completed', conclusion: 'success', url: null }
]
const summary = {
  state: 'failure' as const,
  total: 101,
  passed: 100,
  failed: 1,
  cancelled: 0,
  pending: 0,
  neutral: 0
}
const failedPR = () =>
  makePR({
    url: 'https://github.com/acme/widgets/pull/12',
    prRepo,
    checksStatus: 'failure',
    checksSummary: { ...summary }
  })
const makeStore = () => {
  const store = createTestStore()
  store.setState({ repos: [repo], worktreesByRepo: {} })
  return store
}
async function publish(store: ReturnType<typeof makeStore>, pr: PRInfo) {
  mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'found', pr, fetchedAt: now })
  await store.getState().fetchPRForBranch(repo.path, branch, { repoId: repo.id, force: true })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  setLocalRuntimeCapabilitiesForTests([capability])
  mockApi.gh.prChecks.mockResolvedValue(successfulRows)
})
afterEach(() => {
  vi.useRealTimers()
  setLocalRuntimeCapabilitiesForTests(null)
})

it('keeps complete failure through fresh and cached details, and direct full publication with those cached details', async () => {
  const store = makeStore()
  await publish(store, failedPR())
  await store
    .getState()
    .fetchPRChecks(repo.path, 12, branch, 'head-oid', prRepo, { repoId: repo.id, force: true })
  await store
    .getState()
    .fetchPRChecks(repo.path, 12, branch, 'head-oid', prRepo, { repoId: repo.id })
  await publish(store, failedPR())
  const owner = store.getState().prCache[cacheKey].data!
  expect(owner).toMatchObject({ checksStatus: 'failure', checksSummary: summary })
  expect(Object.values(store.getState().hostedReviewCache)[0].data).toMatchObject({
    status: 'failure',
    checksSummary: summary
  })
  expect(getOverallCheckCounts(successfulRows, owner)).toMatchObject({ passing: 100, failing: 1 })
  expect(Object.values(store.getState().checksCache)[0].data).toEqual(successfulRows)
})

it('keeps the event owner complete when the detail cache contains a successful prefix', async () => {
  const store = makeStore()
  await store
    .getState()
    .fetchPRChecks(repo.path, 12, branch, 'head-oid', prRepo, { repoId: repo.id })
  const alias = { cacheKey, repoId: repo.id, repoPath: repo.path, branch }
  store.getState().applyGitHubPRRefreshEvent({
    sequence: 1,
    aliases: [alias],
    reason: 'manual',
    requestStartedAt: now,
    status: 'in-flight'
  })
  store.getState().applyGitHubPRRefreshEvent({
    sequence: 1,
    aliases: [alias],
    reason: 'manual',
    outcome: { kind: 'found', pr: failedPR(), fetchedAt: now }
  })
  expect(store.getState().prCache[cacheKey].data).toMatchObject({
    checksStatus: 'failure',
    checksSummary: summary
  })
})

it('retires a legacy detail callback when complete-owner mode is adopted on the same head', async () => {
  const store = makeStore()
  setLocalRuntimeCapabilitiesForTests([])
  const delayed = Promise.withResolvers<PRCheckDetail[]>()
  mockApi.gh.prChecks.mockReturnValueOnce(delayed.promise)
  const pending = store
    .getState()
    .fetchPRChecks(repo.path, 12, branch, 'head-oid', prRepo, { repoId: repo.id, force: true })
  setLocalRuntimeCapabilitiesForTests([capability])
  await publish(store, failedPR())
  delayed.resolve(successfulRows)
  await pending
  expect(store.getState().prCache[cacheKey].data).toMatchObject({
    checksStatus: 'failure',
    checksSummary: summary
  })
})

it('keeps same-head last-good checks on unavailable collection, but does not carry them onto another head', async () => {
  const store = makeStore()
  await publish(store, failedPR())
  await publish(
    store,
    makePR({ url: 'https://github.com/acme/widgets/pull/12', prRepo, checksStatus: 'neutral' })
  )
  expect(store.getState().prCache[cacheKey].data).toMatchObject({
    checksStatus: 'failure',
    checksSummary: summary
  })
  await publish(
    store,
    makePR({
      url: 'https://github.com/acme/widgets/pull/12',
      prRepo,
      headSha: 'new-head',
      checksStatus: 'neutral'
    })
  )
  expect(store.getState().prCache[cacheKey].data?.checksSummary).toBeUndefined()
  expect(store.getState().prCache[cacheKey].data?.checksStatus).toBe('neutral')
})

it.each([null, []])(
  'retains legacy detail promotion with absent/unknown support %j',
  async (capabilities) => {
    const store = makeStore()
    setLocalRuntimeCapabilitiesForTests(capabilities)
    await publish(store, failedPR())
    await store
      .getState()
      .fetchPRChecks(repo.path, 12, branch, 'head-oid', prRepo, { repoId: repo.id, force: true })
    expect(store.getState().prCache[cacheKey].data?.checksStatus).toBe('success')
  }
)

it('settles missed-start outcomes and errors without granting their check prefix authority', async () => {
  const store = makeStore()
  await publish(store, failedPR())
  const alias = { cacheKey, repoId: repo.id, repoPath: repo.path, branch }
  store.getState().applyGitHubPRRefreshEvent({
    sequence: 9,
    aliases: [alias],
    reason: 'manual',
    outcome: {
      kind: 'found',
      pr: {
        ...failedPR(),
        title: 'New title',
        checksStatus: 'success',
        checksSummary: { ...summary, state: 'success', passed: 101, failed: 0 }
      },
      fetchedAt: now + 1000
    }
  })
  expect(store.getState().prCache[cacheKey].data).toMatchObject({
    title: 'New title',
    checksStatus: 'failure',
    checksSummary: summary
  })
  expect(store.getState().prRefreshStates[cacheKey]).toBeUndefined()
  store.getState().applyGitHubPRRefreshEvent({
    sequence: 10,
    aliases: [alias],
    reason: 'manual',
    outcome: {
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'Unavailable',
      fetchedAt: now + 2000
    }
  })
  expect(store.getState().prRefreshStates[cacheKey].status).toBe('error')
  store.getState().applyGitHubPRRefreshEvent({
    sequence: 11,
    aliases: [alias],
    reason: 'manual',
    outcome: { kind: 'no-pr', fetchedAt: now + 3000 }
  })
  expect(store.getState().prCache[cacheKey].data).toBeNull()
  expect(store.getState().prRefreshStates[cacheKey]).toBeUndefined()
})

it('does not lose refresh settlement when its request evidence is evicted', async () => {
  const store = makeStore()
  await publish(store, failedPR())
  const alias = { cacheKey, repoId: repo.id, repoPath: repo.path, branch }
  for (let n = 1; n <= 130; n++) {
    store.getState().applyGitHubPRRefreshEvent({
      sequence: n,
      aliases: [{ ...alias, cacheKey: n === 1 ? cacheKey : `other-${n}` }],
      reason: 'manual',
      requestStartedAt: now,
      status: 'in-flight'
    })
  }
  store.getState().applyGitHubPRRefreshEvent({
    sequence: 1,
    aliases: [alias],
    reason: 'manual',
    outcome: {
      kind: 'found',
      pr: { ...failedPR(), title: 'Settled' },
      fetchedAt: now + 1000
    }
  })
  expect(store.getState().prCache[cacheKey].data).toMatchObject({
    title: 'Settled',
    checksStatus: 'failure'
  })
  expect(store.getState().prRefreshStates[cacheKey]).toBeUndefined()
})

it.each(['direct', 'event'] as const)(
  'keeps first-load metadata on capability adoption through %s',
  async (delivery) => {
    const store = makeStore()
    setLocalRuntimeCapabilitiesForTests(null)
    const alias = { cacheKey, repoId: repo.id, repoPath: repo.path, branch }
    const incoming = {
      ...failedPR(),
      title: 'Found during discovery',
      mergeable: 'MERGEABLE' as const
    }
    const deferred = Promise.withResolvers<unknown>()
    let pending: Promise<PRInfo | null> | undefined
    if (delivery === 'direct') {
      mockApi.gh.refreshPRNow.mockReturnValueOnce(deferred.promise)
      pending = store
        .getState()
        .fetchPRForBranch(repo.path, branch, { repoId: repo.id, force: true })
    } else {
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 151,
        aliases: [alias],
        reason: 'manual',
        requestStartedAt: now,
        status: 'in-flight'
      })
    }
    setLocalRuntimeCapabilitiesForTests([capability])
    const outcome = { kind: 'found' as const, pr: incoming, fetchedAt: now + 1 }
    if (pending) {
      deferred.resolve(outcome)
      expect(await pending).toMatchObject({
        title: 'Found during discovery',
        mergeable: 'MERGEABLE',
        checksStatus: 'neutral'
      })
    } else {
      store
        .getState()
        .applyGitHubPRRefreshEvent({ sequence: 151, aliases: [alias], reason: 'manual', outcome })
    }
    const accepted = store.getState().prCache[cacheKey].data!
    expect(accepted).toMatchObject({
      title: 'Found during discovery',
      mergeable: 'MERGEABLE',
      checksStatus: 'neutral'
    })
    expect(accepted.checksSummary).toBeUndefined()
    expect(isCompletePRCheckOwner(accepted)).toBe(true)
    expect(Object.values(store.getState().hostedReviewCache)[0].data).toMatchObject({
      title: 'Found during discovery',
      mergeable: 'MERGEABLE',
      status: 'neutral'
    })
    expect(store.getState().prRefreshStates[cacheKey]).toBeUndefined()
  }
)

it.each(['linked', 'fallback'] as const)(
  'keeps a newer complete owner in both caches against a late unproved %s reply',
  async (mode) => {
    const store = makeStore()
    await publish(store, failedPR())
    setLocalRuntimeCapabilitiesForTests([])
    const deferred = Promise.withResolvers<unknown>()
    mockApi.gh.refreshPRNow.mockReturnValueOnce(deferred.promise)
    const options = mode === 'linked' ? { linkedPRNumber: 12 } : { fallbackPRNumber: 12 }
    const pending = store
      .getState()
      .fetchPRForBranch(repo.path, branch, { repoId: repo.id, force: true, ...options })
    setLocalRuntimeCapabilitiesForTests([capability])
    const alias = { cacheKey, repoId: repo.id, repoPath: repo.path, branch, ...options }
    const fresh = { ...failedPR(), headSha: 'head-2', title: 'New complete owner' }
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 152,
      aliases: [alias],
      reason: 'manual',
      requestStartedAt: now,
      status: 'in-flight'
    })
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 152,
      aliases: [alias],
      reason: 'manual',
      outcome: { kind: 'found', pr: fresh, fetchedAt: now + 1 }
    })
    deferred.resolve({
      kind: 'found',
      pr: {
        ...failedPR(),
        title: 'Late old head',
        checksStatus: 'success',
        checksSummary: { ...summary, state: 'success', passed: 101, failed: 0 }
      },
      fetchedAt: now + 2
    })
    expect(await pending).toMatchObject({
      title: 'New complete owner',
      headSha: 'head-2',
      checksStatus: 'failure'
    })
    expect(store.getState().prCache[cacheKey].data).toMatchObject({
      title: 'New complete owner',
      headSha: 'head-2',
      checksSummary: summary
    })
    expect(Object.values(store.getState().hostedReviewCache)[0].data).toMatchObject({
      title: 'New complete owner',
      headSha: 'head-2',
      checksSummary: summary
    })
  }
)

it('keeps valid metadata but not old-head checks after a capable capture expires', async () => {
  const store = makeStore()
  await publish(store, failedPR())
  const deferred = Promise.withResolvers<unknown>()
  mockApi.gh.refreshPRNow.mockReturnValueOnce(deferred.promise)
  const pending = store
    .getState()
    .fetchPRForBranch(repo.path, branch, { repoId: repo.id, force: true })
  setLocalRuntimeCapabilitiesForTests([])
  deferred.resolve({
    kind: 'found',
    pr: { ...failedPR(), headSha: 'head-2', title: 'New head metadata' },
    fetchedAt: now + 1
  })
  const result = await pending
  expect(result).toMatchObject({
    title: 'New head metadata',
    headSha: 'head-2',
    checksStatus: 'neutral'
  })
  expect(result?.checksSummary).toBeUndefined()
  expect(store.getState().prCache[cacheKey].data?.checksSummary).toBeUndefined()
  expect(Object.values(store.getState().hostedReviewCache)[0].data?.checksSummary).toBeUndefined()
})

it.each([false, true])(
  'allows first runtime discovery at the real before-send boundary (complete=%s)',
  async (complete) => {
    const store = makeStore()
    store.setState({
      repos: [{ ...repo, executionHostId: 'runtime:owner' }],
      runtimeStatusByEnvironmentId: new Map()
    })
    runtimeEnvironmentTransportCall.mockImplementation((args) => {
      if (args.method === 'status.get') {
        const response = createCompatibleRuntimeStatusResponse('owner-1')
        response.result.capabilities = complete ? [capability] : []
        store.setState({
          runtimeStatusByEnvironmentId: new Map([
            ['owner', { status: response.result, checkedAt: now }]
          ])
        })
        return response
      }
      return runtimeEnvironmentCall(args)
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'lookup',
      ok: true,
      result: {
        kind: 'found',
        pr: { ...failedPR(), title: 'Discovered remote' },
        fetchedAt: now + 1
      }
    })
    const result = await store
      .getState()
      .fetchPRForBranch(repo.path, branch, { repoId: repo.id, force: true })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'github.prForBranch' })
    )
    expect(result?.title).toBe('Discovered remote')
    expect(result?.checksStatus).toBe(complete ? 'neutral' : 'failure')
    expect(result?.checksSummary).toEqual(complete ? undefined : summary)
    expect(isCompletePRCheckOwner(result ?? {})).toBe(complete)
    expect(Object.values(store.getState().prCache)[0].data?.title).toBe('Discovered remote')
    expect(Object.values(store.getState().hostedReviewCache)[0].data?.title).toBe(
      'Discovered remote'
    )
  }
)

it.each(['direct', 'event'] as const)(
  'keeps accepted same-head checks when support is absent before the next %s capture',
  async (delivery) => {
    const store = makeStore()
    await publish(store, failedPR())
    setLocalRuntimeCapabilitiesForTests([])
    vi.setSystemTime(now + 1)
    const incoming = {
      ...failedPR(),
      title: 'Updated metadata without proof',
      checksStatus: 'success' as const,
      checksSummary: { ...summary, state: 'success' as const, passed: 101, failed: 0 }
    }
    if (delivery === 'direct') {
      mockApi.gh.refreshPRNow.mockResolvedValueOnce({
        kind: 'found',
        pr: incoming,
        fetchedAt: now + 2
      })
      expect(
        await store.getState().fetchPRForBranch(repo.path, branch, { repoId: repo.id, force: true })
      ).toMatchObject({
        title: 'Updated metadata without proof',
        checksStatus: 'failure',
        checksSummary: summary
      })
    } else {
      const alias = { cacheKey, repoId: repo.id, repoPath: repo.path, branch }
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 160,
        aliases: [alias],
        reason: 'manual',
        requestStartedAt: now + 1,
        status: 'in-flight'
      })
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 160,
        aliases: [alias],
        reason: 'manual',
        outcome: { kind: 'found', pr: incoming, fetchedAt: now + 2 }
      })
    }
    expect(store.getState().prCache[cacheKey].data).toMatchObject({
      title: 'Updated metadata without proof',
      checksStatus: 'failure',
      checksSummary: summary
    })
    expect(Object.values(store.getState().hostedReviewCache)[0].data).toMatchObject({
      title: 'Updated metadata without proof',
      status: 'failure',
      checksSummary: summary
    })
  }
)
