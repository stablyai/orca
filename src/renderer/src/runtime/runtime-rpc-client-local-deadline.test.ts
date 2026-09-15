import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callRuntimeRpc,
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from './runtime-rpc-client'
import { callStructuredAgentSession } from './structured-agent-session-client'

const runtimeCall = vi.fn()
const runtimeEnvironmentCall = vi.fn()

type Outcome = { settled: boolean; failure: string | null; value: unknown }

function trackOutcome(promise: Promise<unknown>): Outcome {
  const outcome: Outcome = { settled: false, failure: null, value: null }
  void promise.then(
    (value) => {
      outcome.settled = true
      outcome.value = value
    },
    (error: unknown) => {
      outcome.settled = true
      outcome.failure = error instanceof Error ? error.message : String(error)
    }
  )
  return outcome
}

function neverSettles(): Promise<never> {
  return new Promise<never>(() => {})
}

beforeEach(() => {
  vi.useFakeTimers()
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtime: { call: runtimeCall },
      runtimeEnvironments: { call: runtimeEnvironmentCall, subscribe: vi.fn() }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('local runtime call deadline', () => {
  it('bounds a local call that declares a timeout', async () => {
    runtimeCall.mockReturnValue(neverSettles())

    const outcome = trackOutcome(
      callRuntimeRpc(
        { kind: 'local' },
        'agentSession.conversationCommand',
        {},
        { timeoutMs: 1_000 }
      )
    )

    await vi.advanceTimersByTimeAsync(999)
    expect(outcome.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(outcome.settled).toBe(true)
    expect(outcome.failure).toContain('timed out before agentSession.conversationCommand completed')
  })

  it('leaves a local call that declares no timeout unbounded', async () => {
    runtimeCall.mockReturnValue(neverSettles())

    const outcome = trackOutcome(callRuntimeRpc({ kind: 'local' }, 'agentSession.send', {}))

    await vi.advanceTimersByTimeAsync(600_000)
    expect(outcome.settled).toBe(false)
  })

  it('applies the structured-session deadline to conversationCommand but not to send', async () => {
    runtimeCall.mockReturnValue(neverSettles())

    const send = trackOutcome(
      callStructuredAgentSession({ kind: 'local' }, 'agentSession.send', {})
    )
    const command = trackOutcome(
      callStructuredAgentSession({ kind: 'local' }, 'agentSession.conversationCommand', {})
    )

    await vi.advanceTimersByTimeAsync(195_001)
    // Why: a send that times out would be classified delivery-unknown, so it must carry no deadline.
    expect(send.settled).toBe(false)
    expect(command.settled).toBe(true)
    expect(command.failure).toContain('timed out before agentSession.conversationCommand completed')
  })

  it('returns a local result that arrives before the deadline and clears the timer', async () => {
    runtimeCall.mockResolvedValue({
      id: 'local',
      ok: true,
      result: { applied: true },
      _meta: { runtimeId: 'local-runtime' }
    })

    const outcome = trackOutcome(
      callRuntimeRpc(
        { kind: 'local' },
        'agentSession.conversationCommand',
        {},
        { timeoutMs: 1_000 }
      )
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toMatchObject({ settled: true, failure: null, value: { applied: true } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still forwards a declared timeout on the remote branch', async () => {
    markRuntimeEnvironmentCompatible('env-1')
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'remote',
      ok: true,
      result: { applied: true },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      callRuntimeRpc(
        { kind: 'environment', environmentId: 'env-1' },
        'agentSession.conversationCommand',
        {},
        { timeoutMs: 195_000 }
      )
    ).resolves.toEqual({ applied: true })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'agentSession.conversationCommand',
        timeoutMs: 195_000
      })
    )
    expect(runtimeCall).not.toHaveBeenCalled()
  })
})
