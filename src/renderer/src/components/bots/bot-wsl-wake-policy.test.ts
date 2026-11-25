import { describe, expect, it } from 'vitest'
import {
  botWslMayAutoWake,
  botWslShowsWaking,
  botWslWakeAfterStatus,
  botWslWakeSettled,
  type BotWslWake
} from './bot-wsl-wake-policy'

const waking = (token: number): BotWslWake => ({ phase: 'waking', token })

describe('bot WSL wake policy', () => {
  it('does not wake again on its own after a failed wake while the host stays idle', () => {
    const failed = botWslWakeSettled(waking(1), 1, false, 'idle')
    expect(failed.toast).toBe(true)
    // Main keeps reporting idle (a refused wake, or a stopped distro rewritten to idle).
    const still = botWslWakeAfterStatus(failed.wake, 'idle').wake
    expect(botWslMayAutoWake(still)).toBe(false)
    expect(botWslMayAutoWake(botWslWakeAfterStatus(still, 'idle').wake)).toBe(false)
  })

  it('allows one more wake once the host left idle and slept again', () => {
    const failed = botWslWakeSettled(waking(1), 1, false, 'idle').wake
    const left = botWslWakeAfterStatus(failed, 'ready').wake
    expect(botWslMayAutoWake(left)).toBe(false)
    expect(botWslMayAutoWake(botWslWakeAfterStatus(left, 'idle').wake)).toBe(true)
  })

  it('keeps Waking while main still connects, then re-reads the host when main is ready', () => {
    const slow = botWslWakeSettled(waking(1), 1, false, 'connecting')
    expect(slow.toast).toBe(false)
    expect(botWslShowsWaking(slow.wake)).toBe(true)
    expect(botWslWakeAfterStatus(slow.wake, 'reconnecting').wake).toEqual(slow.wake)
    expect(botWslWakeAfterStatus(slow.wake, 'ready')).toEqual({
      wake: undefined,
      toast: false,
      refresh: true
    })
    expect(botWslWakeAfterStatus(slow.wake, 'failed').toast).toBe(true)
  })

  it('ignores a connect that settles after a newer wake replaced it', () => {
    // Wake 1 started, the dialog reset and reopened, and wake 2 is now under way.
    const stale = botWslWakeSettled(waking(2), 1, false, 'idle')
    expect(stale).toEqual({ wake: waking(2), toast: false })
    expect(botWslWakeSettled(undefined, 1, false, 'idle')).toEqual({
      wake: undefined,
      toast: false
    })
  })
})
