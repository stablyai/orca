import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginSshConnect,
  endSshConnect,
  isSshConnectInFlight,
  resetSshConnectInFlightForTests,
  subscribeSshConnectInFlight,
  trackSshConnect
} from './ssh-connect-in-flight'
import { SSH_RECONNECT_UI_TIMEOUT_MS, withUiConnectTimeout } from './ssh-connect-ui-timeout'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('ssh connect in-flight registry', () => {
  beforeEach(() => {
    resetSshConnectInFlightForTests()
  })

  it('tracks connects per target, so one host dialing does not disable another', () => {
    beginSshConnect('ssh-a')

    expect(isSshConnectInFlight('ssh-a')).toBe(true)
    expect(isSshConnectInFlight('ssh-b')).toBe(false)
  })

  it('clears the target when the connect settles', () => {
    beginSshConnect('ssh-a')
    endSshConnect('ssh-a')

    expect(isSshConnectInFlight('ssh-a')).toBe(false)
  })

  it('notifies subscribers on both edges', () => {
    const listener = vi.fn()
    subscribeSshConnectInFlight(listener)

    beginSshConnect('ssh-a')
    endSshConnect('ssh-a')

    expect(listener).toHaveBeenCalledTimes(2)
  })

  // Duplicate begin must neither notify all host surfaces nor let its paired end clear a live acquisition.
  it('ignores a duplicate begin without re-notifying', () => {
    const listener = vi.fn()
    subscribeSshConnectInFlight(listener)

    beginSshConnect('ssh-a')
    beginSshConnect('ssh-a')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(isSshConnectInFlight('ssh-a')).toBe(true)
  })

  // Early-return handlers may end locks they never acquired; avoid spurious global card notifications.
  it('ignores an end for a target that was never in flight', () => {
    const listener = vi.fn()
    subscribeSshConnectInFlight(listener)

    endSshConnect('ssh-a')

    expect(listener).not.toHaveBeenCalled()
    expect(isSshConnectInFlight('ssh-a')).toBe(false)
  })

  describe('trackSshConnect', () => {
    it('holds the lock while the request is pending and clears it on resolve', async () => {
      let settle: (value: string) => void = () => {}
      const request = trackSshConnect(
        'ssh-a',
        new Promise<string>((resolve) => {
          settle = resolve
        })
      )

      expect(isSshConnectInFlight('ssh-a')).toBe(true)

      settle('connected')
      await request

      expect(isSshConnectInFlight('ssh-a')).toBe(false)
    })

    it('clears the lock when the request rejects', async () => {
      const request = trackSshConnect('ssh-a', Promise.reject(new Error('Passphrase rejected')))

      await expect(request).rejects.toThrow('Passphrase rejected')
      await Promise.resolve()

      expect(isSshConnectInFlight('ssh-a')).toBe(false)
    })

    // Display timeout leaves backend dialing; retaining lock prevents duplicate connects and credential prompts.
    it('keeps the lock after a UI timeout abandons the wait, so a second dial is suppressed', async () => {
      vi.useFakeTimers()
      try {
        const request = trackSshConnect('ssh-a', new Promise<string>(() => {}))
        const uiWait = withUiConnectTimeout(request, SSH_RECONNECT_UI_TIMEOUT_MS)
        const settled = uiWait.catch((error: Error) => error.message)

        await vi.advanceTimersByTimeAsync(SSH_RECONNECT_UI_TIMEOUT_MS)

        expect(await settled).toContain('timed out')
        expect(isSshConnectInFlight('ssh-a')).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    // Reset/explicit end can precede request settlement; its old release must not unlock a newer acquisition.
    it('ignores a settle whose lock was already cleared, so a later connect keeps its lock', async () => {
      let settleAbandoned: (value: string) => void = () => {}
      const abandoned = trackSshConnect(
        'ssh-a',
        new Promise<string>((resolve) => {
          settleAbandoned = resolve
        })
      )
      resetSshConnectInFlightForTests()

      const listener = vi.fn()
      subscribeSshConnectInFlight(listener)
      beginSshConnect('ssh-a')

      settleAbandoned('connected')
      await abandoned
      await Promise.resolve()

      expect(isSshConnectInFlight('ssh-a')).toBe(true)
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  it('stops notifying after unsubscribe, so unmounted sidebar rows do not leak', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSshConnectInFlight(listener)

    unsubscribe()
    beginSshConnect('ssh-a')

    expect(listener).not.toHaveBeenCalled()
  })
})
