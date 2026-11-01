import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks
} from '../slices/github-slice-test-harness'

// What main's gate rejects with, as IPC delivers it to the renderer.
const refusal = new Error(
  "Error invoking remote method 'gh:issue': WslDistroStoppedError: WSL distro 'Ubuntu' is not running. Retry, or open a terminal in it, to start it."
)
const issue = { number: 7, title: 'Linked', state: 'open', url: 'https://example.test/7' }
const checks: PRCheckDetail[] = [{ name: 'Build', status: 'queued', conclusion: null, url: null }]

function wakeArg(call: readonly unknown[]): unknown {
  const arg = call[0]
  return typeof arg === 'object' && arg !== null && 'wakeWslDistro' in arg
    ? arg.wakeWslDistro
    : undefined
}

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GitHub polls refused for a stopped WSL distro', () => {
  it('keeps the linked issue a card already shows, without logging a failure', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    mockApi.gh.issue.mockResolvedValueOnce(issue)
    await store.getState().fetchIssue('/repo', 7)
    // Past the issue cache's freshness window, so the next card poll asks main again.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    mockApi.gh.issue.mockRejectedValueOnce(refusal)

    await expect(store.getState().fetchIssue('/repo', 7)).resolves.toEqual(issue)

    expect(mockApi.gh.issue).toHaveBeenCalledTimes(2)
    expect(Object.values(store.getState().issueCache).map((entry) => entry.data)).toEqual([issue])
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('still clears the issue and logs for other failures', async () => {
    const store = createTestStore()
    mockApi.gh.issue.mockRejectedValueOnce(new Error('offline'))

    await expect(store.getState().fetchIssue('/repo', 7)).resolves.toBeNull()

    expect(consoleError).toHaveBeenCalled()
  })

  it('serves cached checks quietly when a poll is refused', async () => {
    const store = createTestStore()
    mockApi.gh.prChecks.mockResolvedValueOnce(checks)
    await store.getState().fetchPRChecks('/repo', 1, 'main', 'sha')
    mockApi.gh.prChecks.mockRejectedValueOnce(refusal)

    await expect(
      store.getState().fetchPRChecks('/repo', 1, 'main', 'sha', undefined, { force: true })
    ).resolves.toEqual(checks)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('sends Refresh as a user act and does not join a poll already in flight', async () => {
    const store = createTestStore()
    const poll = Promise.withResolvers<PRCheckDetail[]>()
    mockApi.gh.prChecks.mockReturnValueOnce(poll.promise).mockResolvedValueOnce(checks)

    const polled = store.getState().fetchPRChecks('/repo', 1, 'main', 'sha', undefined, {
      force: true
    })
    const refreshed = store.getState().fetchPRChecks('/repo', 1, 'main', 'sha', undefined, {
      force: true,
      wakeWslDistro: true
    })
    poll.reject(refusal)

    await expect(refreshed).resolves.toEqual(checks)
    await polled
    expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(2)
    expect(mockApi.gh.prChecks.mock.calls[0][0]).not.toHaveProperty('wakeWslDistro')
    expect(mockApi.gh.prChecks.mock.calls[1][0]).toMatchObject({ wakeWslDistro: true })
  })

  it('sends a Tasks user act as a wake, and a fan-out without one', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValue({ items: [], sources: {} })
    const repos = [{ repoId: 'repo-1', path: '/repo' }]

    await store.getState().fetchWorkItemsAcrossRepos(repos, 10, 10, 'is:open')
    await store.getState().countWorkItemsAcrossRepos(repos, 'is:open', 10)
    await store
      .getState()
      .fetchWorkItemsAcrossRepos(repos, 10, 10, 'is:open', { force: true, wakeWslDistro: true })
    await store.getState().countWorkItemsAcrossRepos(repos, 'is:open', 10, { wakeWslDistro: true })

    expect(mockApi.gh.listWorkItems.mock.calls.map(wakeArg)).toEqual([undefined, true])
    expect(mockApi.gh.countWorkItems.mock.calls.map(wakeArg)).toEqual([undefined, true])
  })

  it('lets only a manual PR lookup fallback start the distro', async () => {
    const store = createTestStore()
    const refreshPRNow = mockApi.gh.refreshPRNow
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Removing the optional method exercises the prForBranch fallback.
    ;(mockApi.gh as unknown as { refreshPRNow?: typeof refreshPRNow }).refreshPRNow = undefined
    try {
      await store.getState().fetchPRForBranch('/repo', 'feature/a', { reason: 'visible' })
      await store.getState().fetchPRForBranch('/repo', 'feature/b', { force: true })
    } finally {
      mockApi.gh.refreshPRNow = refreshPRNow
    }

    expect(mockApi.gh.prForBranch.mock.calls.map(wakeArg)).toEqual([undefined, true])
  })
})
