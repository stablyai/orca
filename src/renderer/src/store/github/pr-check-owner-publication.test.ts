import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks
} from '../slices/github-slice-test-harness'
import { setLocalRuntimeCapabilitiesForTests } from '../../runtime/local-runtime-capabilities'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as capability } from '../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { getOverallCheckCounts } from '../../components/pr-check-counts'

const repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 1,
  kind: 'git' as const
}
const prRepo = { owner: 'acme', repo: 'widgets', host: 'github.com' }
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
  mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'found', pr, fetchedAt: Date.now() })
  await store.getState().fetchPRForBranch(repo.path, branch, { repoId: repo.id, force: true })
}
beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  setLocalRuntimeCapabilitiesForTests([capability])
  mockApi.gh.prChecks.mockResolvedValue(successfulRows)
})
afterEach(() => setLocalRuntimeCapabilitiesForTests(null))

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
    requestStartedAt: Date.now(),
    status: 'in-flight'
  })
  store.getState().applyGitHubPRRefreshEvent({
    sequence: 1,
    aliases: [alias],
    reason: 'manual',
    outcome: { kind: 'found', pr: failedPR(), fetchedAt: Date.now() }
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
      fetchedAt: Date.now() + 1000
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
      fetchedAt: Date.now() + 2000
    }
  })
  expect(store.getState().prRefreshStates[cacheKey].status).toBe('error')
  store.getState().applyGitHubPRRefreshEvent({
    sequence: 11,
    aliases: [alias],
    reason: 'manual',
    outcome: { kind: 'no-pr', fetchedAt: Date.now() + 3000 }
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
      requestStartedAt: Date.now(),
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
      fetchedAt: Date.now() + 1000
    }
  })
  expect(store.getState().prCache[cacheKey].data).toMatchObject({
    title: 'Settled',
    checksStatus: 'failure'
  })
  expect(store.getState().prRefreshStates[cacheKey]).toBeUndefined()
})
