import { describe, expect, it } from 'vitest'
import { resolvePushFailureRawError } from './source-control-push-failure-context'

describe('resolvePushFailureRawError', () => {
  it('returns raw push hook output for push-like remote failures', () => {
    const raw =
      "husky - pre-push hook exited with code 1\nerror: failed to push some refs to 'origin'"

    expect(
      resolvePushFailureRawError({
        kind: 'push',
        message: 'Push blocked — pre-push hook failed.',
        rawError: raw
      })
    ).toBe(raw)
  })

  it('returns null for non-push remote operations', () => {
    expect(
      resolvePushFailureRawError({
        kind: 'fetch',
        message: 'Fetch failed. network timeout',
        rawError: 'network timeout'
      })
    ).toBeNull()
  })

  it('returns null when auth failures are not hook failures', () => {
    expect(
      resolvePushFailureRawError({
        kind: 'push',
        message: 'Push failed. Authentication failed. Check your remote access and try again.',
        rawError: 'remote: Repository not found.\nfatal: Authentication failed'
      })
    ).toBeNull()
  })

  it('returns null when only a formatted message is present', () => {
    expect(
      resolvePushFailureRawError({
        kind: 'push',
        message: 'Push blocked — lint failed during push.'
      })
    ).toBeNull()
  })
})
