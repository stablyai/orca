import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { AppState } from '../types'
import { createHostedReviewSlice } from './hosted-review'
import {
  _clearHostedReviewRequestGenerationsForTest,
  hostedReviewRequestGenerations,
  inflightHostedReviewRequests
} from './hosted-review-request-state'

const runtimeRpc = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: runtimeRpc.callRuntimeRpc,
  getActiveRuntimeTarget: (settings: AppState['settings']) => {
    const environmentId = settings?.activeRuntimeEnvironmentId
    return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
  }
}))

const forBranch = vi.fn()
type TestState = Pick<
  AppState,
  | 'settings'
  | 'repos'
  | 'prCache'
  | 'hostedReviewCache'
  | 'fetchHostedReviewForBranch'
  | 'getHostedReviewCreationEligibility'
  | 'createHostedReview'
  | 'createStackedHostedReview'
>

function makeStore(runtime = false) {
  return create<TestState>()((...args) => ({
    settings: null,
    repos: [
      {
        id: 'repo',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: 'blue',
        addedAt: 1,
        ...(runtime ? { executionHostId: 'runtime:env-1' } : {})
      }
    ],
    prCache: {},
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This harness provides every state field read by the hosted-review slice.
    ...createHostedReviewSlice(...(args as Parameters<typeof createHostedReviewSlice>))
  }))
}

function review(number: number): HostedReviewInfo {
  return {
    provider: 'gitlab',
    number,
    title: `Review ${number}`,
    state: 'open',
    url: `https://gitlab.com/group/project/-/merge_requests/${number}`,
    status: 'success',
    updatedAt: '2026-09-25T00:00:00Z',
    mergeable: 'MERGEABLE'
  }
}

beforeEach(() => {
  _clearHostedReviewRequestGenerationsForTest()
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  forBranch.mockReset()
  runtimeRpc.callRuntimeRpc.mockReset()
  vi.stubGlobal('window', { api: { hostedReview: { forBranch } } })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  _clearHostedReviewRequestGenerationsForTest()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const cases = [
  { route: 'local', replacement: 'force', outcome: 'found' },
  { route: 'local', replacement: 'force', outcome: 'rejected' },
  { route: 'local', replacement: 'hint', outcome: 'found' },
  { route: 'runtime', replacement: 'force', outcome: 'found' },
  { route: 'runtime', replacement: 'force', outcome: 'missing' },
  { route: 'runtime', replacement: 'hint', outcome: 'rejected' }
] as const

describe('hosted review lookup ownership after newer settlement', () => {
  it.each(cases)(
    'preserves $route lookup after late $outcome with $replacement replacement',
    async ({ route, replacement, outcome }) => {
      const store = makeStore(route === 'runtime')
      const pending: ReturnType<typeof Promise.withResolvers<HostedReviewInfo | null>>[] = []
      const startRequest = () => {
        const request = Promise.withResolvers<HostedReviewInfo | null>()
        pending.push(request)
        return request.promise
      }
      const dispatch = route === 'runtime' ? runtimeRpc.callRuntimeRpc : forBranch
      dispatch.mockImplementation(startRequest)
      const branch = `${route}-${replacement}-${outcome}`
      const firstOptions = replacement === 'hint' ? { force: true, linkedGitLabMR: 10 } : {}
      const first = store.getState().fetchHostedReviewForBranch('/repo', branch, firstOptions)
      vi.setSystemTime(2000)
      const options = replacement === 'hint' ? { force: true, linkedGitLabMR: 20 } : { force: true }
      const second = store.getState().fetchHostedReviewForBranch('/repo', branch, options)
      expect(pending).toHaveLength(2)
      pending[1].resolve(review(20))
      await second
      expect(hostedReviewRequestGenerations.size).toBe(0)
      vi.setSystemTime(3000)
      const third = store.getState().fetchHostedReviewForBranch('/repo', branch, options)
      expect(pending).toHaveLength(3)
      const entry = [...inflightHostedReviewRequests.entries()].at(-1)
      expect(entry).toBeDefined()
      if (!entry) {
        throw new Error('Expected a pending lookup')
      }
      const [key, owner] = entry
      const cacheKey = [...hostedReviewRequestGenerations.keys()][0]
      const generationBefore = hostedReviewRequestGenerations.get(cacheKey)
      if (outcome === 'rejected') {
        pending[0].reject(new Error('Old lookup failed'))
      } else {
        pending[0].resolve(outcome === 'missing' ? null : review(10))
      }
      await first
      const currentOwner = inflightHostedReviewRequests.get(key)
      const generationAfter = hostedReviewRequestGenerations.get(cacheKey)
      const cachedBefore = store.getState().hostedReviewCache[cacheKey].data
      const follower = store.getState().fetchHostedReviewForBranch('/repo', branch, options)
      const requestCount = pending.length
      pending[2].resolve(review(30))
      pending[3]?.resolve(review(40))
      const results = await Promise.all([third, follower])

      expect(currentOwner).toBe(owner)
      expect(generationAfter).toBe(generationBefore)
      expect(cachedBefore?.number).toBe(20)
      expect(requestCount).toBe(3)
      expect(results.map((result) => result?.number)).toEqual([30, 30])
      expect(store.getState().hostedReviewCache[cacheKey].data?.number).toBe(30)
      expect(inflightHostedReviewRequests.size).toBe(0)
      expect(hostedReviewRequestGenerations.size).toBe(0)
      expect(route === 'runtime' ? forBranch : runtimeRpc.callRuntimeRpc).not.toHaveBeenCalled()
    }
  )

  it('dedupes each branch independently and removes settled generation entries', async () => {
    const store = makeStore()
    const pending = Promise.withResolvers<HostedReviewInfo | null>()
    forBranch.mockReturnValue(pending.promise)
    const callers = ['one', 'two'].flatMap((branch) =>
      Array.from({ length: 10 }, () =>
        store.getState().fetchHostedReviewForBranch('/repo', branch, { force: true })
      )
    )
    expect(forBranch).toHaveBeenCalledTimes(2)
    expect(hostedReviewRequestGenerations.size).toBe(2)
    pending.resolve(review(20))
    await Promise.all(callers)
    expect(inflightHostedReviewRequests.size).toBe(0)
    expect(hostedReviewRequestGenerations.size).toBe(0)
  })
})
