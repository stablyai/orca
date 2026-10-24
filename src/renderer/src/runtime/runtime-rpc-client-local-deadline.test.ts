import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from './runtime-rpc-client'
import { sharedPromiseSettlementWaiters } from '../../../shared/promise-settlement-waiters'

const runtimeCall = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  runtimeCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtime: { call: runtimeCall },
      runtimeEnvironments: { call: vi.fn(), subscribe: vi.fn() }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('local runtime RPC deadline', () => {
  it('rejects a stalled local call once the caller deadline elapses', async () => {
    runtimeCall.mockReturnValue(new Promise(() => {}))
    const pending = callRuntimeRpc({ kind: 'local' }, 'automation.list', undefined, {
      timeoutMs: 15_000
    })
    const assertion = expect(pending).rejects.toThrow(
      'Runtime request timed out before automation.list completed'
    )
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
  })

  it('rejects a stalled local call when the caller aborts', async () => {
    runtimeCall.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const pending = callRuntimeRpc({ kind: 'local' }, 'automation.list', undefined, {
      timeoutMs: 15_000,
      signal: controller.signal
    })
    const assertion = expect(pending).rejects.toThrow('Runtime request aborted')
    controller.abort()
    await assertion
  })

  it('rejects when the caller signal is already aborted', async () => {
    runtimeCall.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    controller.abort()
    await expect(
      callRuntimeRpc({ kind: 'local' }, 'automation.list', undefined, {
        timeoutMs: 15_000,
        signal: controller.signal
      })
    ).rejects.toThrow('Runtime request aborted')
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('unwraps a successful local response', async () => {
    runtimeCall.mockResolvedValue({
      id: 'desktop-ipc',
      ok: true,
      result: { automations: [] },
      _meta: { runtimeId: 'local-runtime' }
    })
    await expect(
      callRuntimeRpc({ kind: 'local' }, 'automation.list', undefined, {})
    ).resolves.toEqual({ automations: [] })
  })

  it('leaves a stalled call without options unbounded', async () => {
    runtimeCall.mockReturnValue(new Promise(() => {}))
    const settled = vi.fn()
    void callRuntimeRpc({ kind: 'local' }, 'automation.list').then(settled, settled)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(settled).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resolve', 'reject'])('cleans up after early %s', async (outcome) => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const failure = new Error('host failure')
    runtimeCall.mockReturnValue(
      outcome === 'resolve'
        ? Promise.resolve({ ok: true, result: { automations: [] } })
        : Promise.reject(failure)
    )
    const pending = callRuntimeRpc({ kind: 'local' }, 'automation.list', undefined, {
      timeoutMs: 15_000,
      signal: controller.signal
    })
    await (outcome === 'resolve'
      ? expect(pending).resolves.toEqual({ automations: [] })
      : expect(pending).rejects.toBe(failure))
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
  })

  it('detaches a timed-out caller while still observing late IPC rejection', async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    let rejectHost: (error: Error) => void = () => {}
    const raw = new Promise<never>((_resolve, reject) => {
      rejectHost = reject
    })
    runtimeCall.mockReturnValue(raw)
    const waiters = sharedPromiseSettlementWaiters(raw)
    const pending = callRuntimeRpc({ kind: 'local' }, 'automation.list', undefined, {
      timeoutMs: 15_000,
      signal: controller.signal
    })
    const assertion = expect(pending).rejects.toThrow('Runtime request timed out')
    expect(waiters.waiterCount).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
    expect(waiters.waiterCount).toBe(0)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    rejectHost(new Error('late IPC failure'))
    await vi.advanceTimersByTimeAsync(0)
  })
})
