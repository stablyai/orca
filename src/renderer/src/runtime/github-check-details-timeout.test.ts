import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GITHUB_CHECK_DETAILS_TIMEOUT_MS,
  withGitHubCheckDetailsTimeout
} from './github-check-details-timeout'

vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string) =>
    key === 'auto.runtime.githubCheckDetailsTimeout.timedOut' ? 'Localized timeout.' : fallback
}))

describe('withGitHubCheckDetailsTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes through a result and clears its deadline', async () => {
    await expect(withGitHubCheckDetailsTimeout(() => Promise.resolve('details'))).resolves.toBe(
      'details'
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the timeout error when abort-aware work rejects synchronously', async () => {
    const stalled = withGitHubCheckDetailsTimeout(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('operation aborted')), {
            once: true
          })
        })
    )
    const assertion = expect(stalled).rejects.toThrow('Localized timeout.')

    await vi.advanceTimersByTimeAsync(GITHUB_CHECK_DETAILS_TIMEOUT_MS)

    await assertion
  })
})
