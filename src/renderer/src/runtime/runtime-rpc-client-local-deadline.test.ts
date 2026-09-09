import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from './runtime-rpc-client'

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
})

describe('local runtime RPC deadline', () => {
  it('rejects a stalled local call once the caller deadline elapses', async () => {
    // Why: a main-process dispatch that never returns used to leave this promise
    // pending forever, freezing every surface that awaits it (Automations).
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
    // Why: an aborted signal never fires 'abort', so a listener-only guard would
    // leave the promise pending forever.
    runtimeCall.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    controller.abort()
    await expect(
      callRuntimeRpc({ kind: 'local' }, 'automation.list', undefined, {
        timeoutMs: 15_000,
        signal: controller.signal
      })
    ).rejects.toThrow('Runtime request aborted')
  })

  it('leaves a call without a caller deadline unbounded', async () => {
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
})
