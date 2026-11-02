import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SSH_CONNECT_UI_TIMEOUT_MS,
  SSH_RECONNECT_UI_TIMEOUT_MS,
  withUiConnectTimeout
} from './ssh-connect-ui-timeout'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('withUiConnectTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Bound UI wait because ssh.connect itself can stall without timeout.
  it('rejects a stalled connect once the UI budget elapses', async () => {
    const stalled = withUiConnectTimeout(new Promise(() => {}))
    const assertion = expect(stalled).rejects.toThrow(/Connection timed out/)

    await vi.advanceTimersByTimeAsync(SSH_CONNECT_UI_TIMEOUT_MS)

    await assertion
  })

  // Reconnect budget must cover main’s 120s passphrase prompt beyond the shorter composer default.
  it('honours a caller-supplied budget instead of the composer default', async () => {
    const stalled = withUiConnectTimeout(new Promise(() => {}), SSH_RECONNECT_UI_TIMEOUT_MS)
    const assertion = expect(stalled).rejects.toThrow(/Connection timed out/)

    await vi.advanceTimersByTimeAsync(SSH_CONNECT_UI_TIMEOUT_MS)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(SSH_RECONNECT_UI_TIMEOUT_MS - SSH_CONNECT_UI_TIMEOUT_MS)
    await assertion
  })

  it('clears the timer when the connect settles first, leaving no pending work', async () => {
    await withUiConnectTimeout(Promise.resolve('connected'))

    expect(vi.getTimerCount()).toBe(0)
  })
})
