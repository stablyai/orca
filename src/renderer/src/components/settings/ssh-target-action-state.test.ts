import { describe, expect, it } from 'vitest'
import { isSshTargetConnecting, shouldClearPendingSshReset } from './ssh-target-action-state'

describe('ssh target action state', () => {
  it('classifies connecting statuses as busy connection states', () => {
    expect(isSshTargetConnecting('connecting')).toBe(true)
    expect(isSshTargetConnecting('deploying-relay')).toBe(true)
    expect(isSshTargetConnecting('reconnecting')).toBe(true)
    expect(isSshTargetConnecting('connected')).toBe(false)
    expect(isSshTargetConnecting('disconnected')).toBe(false)
  })

  it('clears pending reset only when a non-busy target starts connecting', () => {
    expect(
      shouldClearPendingSshReset({
        pendingTargetId: 'target-1',
        pendingResetIsBusy: false,
        connectionStatus: 'reconnecting'
      })
    ).toBe(true)

    expect(
      shouldClearPendingSshReset({
        pendingTargetId: 'target-1',
        pendingResetIsBusy: true,
        connectionStatus: 'reconnecting'
      })
    ).toBe(false)

    expect(
      shouldClearPendingSshReset({
        pendingTargetId: null,
        pendingResetIsBusy: false,
        connectionStatus: 'reconnecting'
      })
    ).toBe(false)

    expect(
      shouldClearPendingSshReset({
        pendingTargetId: 'target-1',
        pendingResetIsBusy: false,
        connectionStatus: 'connected'
      })
    ).toBe(false)
  })
})
