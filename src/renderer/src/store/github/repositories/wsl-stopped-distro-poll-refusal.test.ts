import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from '../github-slice-test-harness'

// What main's gate rejects with, as IPC delivers it to the renderer.
const refusal = new Error(
  "Error invoking remote method 'gh:issue': WslDistroStoppedError: WSL distro 'Ubuntu' is not running. Retry, or open a terminal in it, to start it."
)
const issue = { number: 7, title: 'Linked', state: 'open', url: 'https://example.test/7' }
const checks: PRCheckDetail[] = [{ name: 'Build', status: 'queued', conclusion: null, url: null }]

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

    expect(Object.values(store.getState().issueCache).map((entry) => entry.data)).toEqual([issue])
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

    expect(mockApi.gh.prChecks.mock.calls[0][0]).not.toHaveProperty('wakeWslDistro')
    expect(mockApi.gh.prChecks.mock.calls[1][0]).toMatchObject({ wakeWslDistro: true })
  })
})
