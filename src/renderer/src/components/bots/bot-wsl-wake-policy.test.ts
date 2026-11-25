import { describe, expect, it } from 'vitest'
import {
  botWslMayAutoWake,
  botWslShowsWaking,
  botWslWakeAfterStatus,
  botWslWakeSettled
} from './bot-wsl-wake-policy'

describe('bot WSL wake policy', () => {
  it('does not wake again on its own after a failed wake while the host stays idle', () => {
    const failed = botWslWakeSettled(false, 'idle')
    expect(failed.toast).toBe(true)
    // Main keeps reporting idle (a refused wake, or a stopped distro rewritten to idle).
    const still = botWslWakeAfterStatus(failed.wake, 'idle').wake
    expect(botWslMayAutoWake(still)).toBe(false)
    expect(botWslMayAutoWake(botWslWakeAfterStatus(still, 'idle').wake)).toBe(false)
  })

  it('allows one more wake once the host left idle and slept again', () => {
    const failed = botWslWakeSettled(false, 'idle').wake
    const left = botWslWakeAfterStatus(failed, 'ready').wake
    expect(botWslMayAutoWake(left)).toBe(false)
    expect(botWslMayAutoWake(botWslWakeAfterStatus(left, 'idle').wake)).toBe(true)
  })

  it('keeps Waking while main still connects after the connect call timed out', () => {
    const slow = botWslWakeSettled(false, 'connecting')
    expect(slow.toast).toBe(false)
    expect(botWslShowsWaking(slow.wake)).toBe(true)
    expect(botWslWakeAfterStatus(slow.wake, 'connecting').wake).toEqual(slow.wake)
    expect(botWslWakeAfterStatus(slow.wake, 'ready')).toEqual({ wake: undefined, toast: false })
    expect(botWslWakeAfterStatus(slow.wake, 'failed').toast).toBe(true)
  })
})
