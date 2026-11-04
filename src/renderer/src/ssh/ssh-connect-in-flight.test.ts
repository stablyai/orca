import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginSshConnect,
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

  describe('trackSshConnect', () => {
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
})
