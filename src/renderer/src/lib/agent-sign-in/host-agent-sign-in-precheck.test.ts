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

  it('asks a host that connected', () => {
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({}))
    vi.runAllTimers()
    expect(precheck).toHaveBeenCalledWith('env-1')
  })

  it('never asks a host that is not connected, such as a suspended VM', () => {
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ transport: 'disconnected' }))
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ verification: 'unavailable' }))
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ retired: true }))
    vi.runAllTimers()
    expect(precheck).not.toHaveBeenCalled()
  })

  it('drops the ask when the host goes away before it fires', () => {
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({}))
    observeRuntimeHostStatusForAgentSignInPrecheck(snapshot({ transport: 'connecting' }))
    vi.runAllTimers()
    expect(precheck).not.toHaveBeenCalled()
  })
})
