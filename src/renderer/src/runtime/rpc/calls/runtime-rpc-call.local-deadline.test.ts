import { afterEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from './runtime-rpc-call'

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

function stubLocalRuntimeCall(
  call: (args: { method: string; params?: unknown }) => Promise<unknown>
): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { runtime: { call } } }
  })
}

afterEach(() => {
  vi.useRealTimers()
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

describe('callRuntimeRpc local deadline', () => {
  it('rejects when a local call outlives the caller timeoutMs', async () => {
    vi.useFakeTimers()
    stubLocalRuntimeCall(() => new Promise(() => {}))
    const call = callRuntimeRpc({ kind: 'local' }, 'files.read', undefined, { timeoutMs: 50 })
    const rejection = expect(call).rejects.toThrow(
      'Runtime request timed out before files.read completed'
    )
    await vi.advanceTimersByTimeAsync(50)
    await rejection
  })

  it('rejects a local call when the caller signal aborts', async () => {
    stubLocalRuntimeCall(() => new Promise(() => {}))
    const controller = new AbortController()
    const call = callRuntimeRpc({ kind: 'local' }, 'files.read', undefined, {
      signal: controller.signal
    })
    controller.abort()
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('still returns a local response that arrives before the deadline', async () => {
    stubLocalRuntimeCall(async () => ({ ok: true, result: { value: 7 } }))
    await expect(
      callRuntimeRpc({ kind: 'local' }, 'files.read', undefined, { timeoutMs: 50 })
    ).resolves.toEqual({ value: 7 })
  })
})
