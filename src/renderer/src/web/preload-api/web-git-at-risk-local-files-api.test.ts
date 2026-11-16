import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  recordRuntimeSubscription,
  stubRuntimeEnvironmentBridge
} from '../../runtime/rpc/testing/runtime-environment-bridge-fixture'

vi.mock('./web-runtime-worktree-catalog', () => ({
  resolveRuntimeWorktreeByPath: vi.fn().mockResolvedValue({ id: 'wt-1' })
}))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironment: () => ({ id: 'env-1' }),
  updateEnvironmentFromResponse: vi.fn()
}))

import { createWebGitAtRiskLocalFilesApi } from './web-git-at-risk-local-files-api'

describe('web git atRiskLocalFiles', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('rejects a silent connected host at the default 30 s deadline and releases its subscription', async () => {
    vi.useFakeTimers()
    // The host accepts the subscription but never sends a response frame.
    let subscriptionReleased = false
    const host = recordRuntimeSubscription({
      unsubscribe: () => {
        subscriptionReleased = true
      }
    })
    stubRuntimeEnvironmentBridge({
      subscribe: host.subscribe,
      cancelSubscription: vi.fn().mockResolvedValue(undefined)
    })
    const api = createWebGitAtRiskLocalFilesApi()

    let outcome: unknown
    void api
      .atRiskLocalFiles({
        worktreePath: '/repo-feature',
        requestToken: 'at-risk-3'
      })
      .then(
        (result) => {
          outcome = { result }
        },
        (error: unknown) => {
          outcome = { error }
        }
      )
    try {
      await vi.advanceTimersByTimeAsync(29_999)
      expect(outcome).toBeUndefined()
      expect(subscriptionReleased).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      expect(outcome).toEqual({
        error: new Error('Runtime request timed out before git.atRiskLocalFiles completed')
      })
      expect(subscriptionReleased).toBe(true)
    } finally {
      await api.cancelAtRiskLocalFiles({ requestToken: 'at-risk-3' })
    }
  })
})
