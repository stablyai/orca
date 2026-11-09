import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-status'

const precheck = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client', () => ({
  precheckHostAgentSignIn: precheck
}))

const { observeRuntimeHostStatusForAgentSignInPrecheck, _resetAgentSignInPrecheckForTest } =
  await import('./host-agent-sign-in-precheck')

function snapshot(patch: Partial<RuntimeHostStatusSnapshot>): RuntimeHostStatusSnapshot {
  return {
    environmentId: 'env-1',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 0,
    status: null,
    verification: 'verified',
    transport: 'ready',
    ...patch
  }
}

describe('agent sign-in pre-check on host connect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    precheck.mockReset()
    _resetAgentSignInPrecheckForTest()
  })
  afterEach(() => vi.useRealTimers())

  it('asks once per connection, after the connect settles', () => {
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({}))
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ sequence: 2 }))
    expect(precheck).not.toHaveBeenCalled()
    vi.advanceTimersByTime(3_000)
    expect(precheck).toHaveBeenCalledTimes(1)
    expect(precheck).toHaveBeenCalledWith('env-1')

    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ transport: 'disconnected' }))
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ sequence: 3 }))
    vi.advanceTimersByTime(3_000)
    expect(precheck).toHaveBeenCalledTimes(2)
  })

  it('never asks a host that is not connected, such as a suspended VM', () => {
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ transport: 'disconnected' }))
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ verification: 'unavailable' }))
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ retired: true }))
    vi.advanceTimersByTime(10_000)
    expect(precheck).not.toHaveBeenCalled()
  })

  it('drops the ask when the host goes away before it fires', () => {
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({}))
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ transport: 'connecting' }))
    vi.advanceTimersByTime(3_000)
    expect(precheck).not.toHaveBeenCalled()
  })
})
