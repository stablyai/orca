import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import { inflightPRRequests, prRequestGenerations } from '../github/request-coordination'
import {
  createTestStore,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  mockApi.gh.refreshPRNow.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function found(number: number): PRRefreshOutcome {
  return { kind: 'found', pr: makePR({ number }), fetchedAt: Date.now() }
}

const cases = [
  { route: 'local', replacement: 'force', outcome: 'found' },
  { route: 'local', replacement: 'hint', outcome: 'found' },
  { route: 'local', replacement: 'force', outcome: 'rejected' },
  { route: 'runtime', replacement: 'force', outcome: 'found' },
  { route: 'runtime', replacement: 'force', outcome: 'upstream-error' },
  { route: 'runtime', replacement: 'hint', outcome: 'no-pr' }
] as const

describe('pull-request lookup ownership after newer settlement', () => {
  it.each(cases)(
    'preserves $route lookup after late $outcome with $replacement replacement',
    async ({ route, replacement, outcome }) => {
      const store = createTestStore()
      const pending: ReturnType<typeof Promise.withResolvers<PRRefreshOutcome>>[] = []
      const startRequest = () => {
        const request = Promise.withResolvers<PRRefreshOutcome>()
        pending.push(request)
        return request.promise
      }
      if (route === 'runtime') {
        store.setState({
          repos: [
            {
              id: 'runtime-repo',
              path: '/runtime/repo',
              displayName: 'Runtime repo',
              badgeColor: 'blue',
              addedAt: 1,
              executionHostId: 'runtime:env-1'
            }
          ]
        })
        runtimeEnvironmentCall.mockImplementation(async () => ({
          id: 'rpc',
          ok: true,
          result: await startRequest()
        }))
      } else {
        mockApi.gh.refreshPRNow.mockImplementation(startRequest)
      }
      const path = route === 'runtime' ? '/runtime/repo' : '/local/repo'
      const branch = `lifetime-${route}-${replacement}-${outcome}`
      const options = replacement === 'hint' ? { force: true, fallbackPRNumber: 10 } : undefined
      const first = store.getState().fetchPRForBranch(path, branch, options)
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      vi.setSystemTime(2000)
      const secondOptions =
        replacement === 'hint' ? { force: true, fallbackPRNumber: 20 } : { force: true }
      const second = store.getState().fetchPRForBranch(path, branch, secondOptions)
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      pending[1].resolve(found(20))
      await second
      expect(prRequestGenerations.size).toBe(0)

      vi.setSystemTime(3000)
      const third = store.getState().fetchPRForBranch(path, branch, secondOptions)
      await vi.waitFor(() => expect(pending).toHaveLength(3))
      const activeBefore = [...inflightPRRequests.values()][0]
      const key = [...inflightPRRequests.keys()][0]
      expect(activeBefore).toBeDefined()
      if (outcome === 'rejected') {
        pending[0].reject(new Error('old lookup failed'))
      } else if (outcome === 'upstream-error') {
        pending[0].resolve({
          kind: 'upstream-error',
          message: 'old error',
          errorType: 'unknown',
          fetchedAt: 3000
        })
      } else if (outcome === 'no-pr') {
        pending[0].resolve({ kind: 'no-pr', fetchedAt: 3000 })
      } else {
        pending[0].resolve(found(10))
      }
      await first
      const activeAfter = inflightPRRequests.get(key)
      const refreshStateAfter = store.getState().prRefreshStates[key]
      vi.setSystemTime(4000)
      const follower = store.getState().fetchPRForBranch(path, branch, secondOptions)
      await vi.waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(3))
      await Promise.resolve()
      const requestCount = pending.length
      pending[2].resolve(found(30))
      pending[3]?.resolve(found(40))
      const results = await Promise.all([third, follower])

      expect(activeAfter).toBe(activeBefore)
      expect(refreshStateAfter).toBeUndefined()
      expect(requestCount).toBe(3)
      expect(results.map((result) => result?.number)).toEqual([30, 30])
      expect(inflightPRRequests.size).toBe(0)
      expect(prRequestGenerations.size).toBe(0)
      if (route === 'runtime') {
        expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
      } else {
        expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
      }
    }
  )

  it('dedupes each branch independently and removes settled generation entries', async () => {
    const store = createTestStore()
    const pending = Promise.withResolvers<PRRefreshOutcome>()
    mockApi.gh.refreshPRNow.mockReturnValue(pending.promise)
    const calls = ['one', 'two'].flatMap((branch) =>
      Array.from({ length: 10 }, () =>
        store.getState().fetchPRForBranch('/repo', branch, { force: true })
      )
    )
    expect(mockApi.gh.refreshPRNow).toHaveBeenCalledTimes(2)
    expect(prRequestGenerations.size).toBe(2)

    pending.resolve(found(12))
    await Promise.all(calls)

    expect(inflightPRRequests.size).toBe(0)
    expect(prRequestGenerations.size).toBe(0)
  })
})
