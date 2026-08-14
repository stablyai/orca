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

  it('rejects a stalled renderer operation after the check-details budget', async () => {
    let operationSignal: AbortSignal | undefined
    const stalled = withGitHubCheckDetailsTimeout((signal) => {
      operationSignal = signal
      return new Promise(() => {})
    })
    const assertion = expect(stalled).rejects.toThrow('Localized timeout.')

    await vi.advanceTimersByTimeAsync(GITHUB_CHECK_DETAILS_TIMEOUT_MS)

    await assertion
    expect(operationSignal?.aborted).toBe(true)
  })

  it('arms the renderer deadline before starting the operation', async () => {
    let timerCountWhenStarted = 0

    const result = withGitHubCheckDetailsTimeout(async () => {
      timerCountWhenStarted = vi.getTimerCount()
      return 'details'
    })

    await expect(result).resolves.toBe('details')
    expect(timerCountWhenStarted).toBe(1)
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

  it.each([
    'Timed out loading check details.',
    "Error invoking remote method 'gh:prCheckDetails': Error: Timed out loading check details."
  ])('normalizes host timeout errors: %s', async (message) => {
    await expect(
      withGitHubCheckDetailsTimeout(() => Promise.reject(new Error(message)))
    ).rejects.toMatchObject({ message: 'Localized timeout.' })
  })

  it('preserves unrelated operation failures', async () => {
    await expect(
      withGitHubCheckDetailsTimeout(() => Promise.reject(new Error('authentication failed')))
    ).rejects.toThrow('authentication failed')
  })
})
