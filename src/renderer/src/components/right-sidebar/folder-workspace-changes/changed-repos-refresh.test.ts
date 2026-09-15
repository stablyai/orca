import { describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '../../../../../shared/git-status-types'
import type { FolderWorkspaceRepoStatusOutcome } from './changed-repo-model'
import { runLimitedRepoStatusRefreshes } from './changed-repos-refresh'

const EMPTY: GitStatusResult = { entries: [], conflictOperation: 'unknown' }

function candidates(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/meta/repo-${index}`,
    name: `repo-${index}`
  }))
}

describe('runLimitedRepoStatusRefreshes', () => {
  it('never runs more fetches at once than the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const outcomes = await runLimitedRepoStatusRefreshes({
      candidates: candidates(9),
      concurrency: 3,
      fetchStatus: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        inFlight -= 1
        return EMPTY
      }
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(outcomes.size).toBe(9)
    expect([...outcomes.values()].every((outcome) => outcome.kind === 'ready')).toBe(true)
  })

  it('reports loading before the result and keeps going past a failing repo', async () => {
    const seen: [string, FolderWorkspaceRepoStatusOutcome['kind']][] = []
    const failure = new Error('git missing')
    const outcomes = await runLimitedRepoStatusRefreshes({
      candidates: candidates(2),
      concurrency: 1,
      fetchStatus: async (candidate) => {
        if (candidate.name === 'repo-0') {
          throw failure
        }
        return EMPTY
      },
      onOutcome: (repoPath, outcome) => {
        seen.push([repoPath, outcome.kind])
      }
    })
    expect(seen).toEqual([
      ['/meta/repo-0', 'loading'],
      ['/meta/repo-0', 'error'],
      ['/meta/repo-1', 'loading'],
      ['/meta/repo-1', 'ready']
    ])
    expect(outcomes.get('/meta/repo-0')).toEqual({
      kind: 'error',
      error: failure
    })
  })

  it('stops scheduling and drops late results once aborted', async () => {
    const controller = new AbortController()
    const onOutcome = vi.fn()
    const fetchStatus = vi.fn(async () => {
      controller.abort()
      return EMPTY
    })
    const outcomes = await runLimitedRepoStatusRefreshes({
      candidates: candidates(4),
      concurrency: 1,
      signal: controller.signal,
      fetchStatus,
      onOutcome
    })
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(outcomes.size).toBe(1)
    expect(onOutcome).toHaveBeenCalledTimes(1)
    expect(onOutcome.mock.calls[0]?.[1]).toEqual({ kind: 'loading' })
  })
})
