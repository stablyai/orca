import { beforeEach, describe, expect, it, vi } from 'vitest'

// Why: the transport suppresses a repeat of the message it last surfaced so one outage cannot spam the
// pane. Dismissal is the only evidence the user consumed that surface, so it must re-arm the memory —
// otherwise an identical fatal error recurring during the same outage leaves a dead pane looking fine.
describe('remote runtime error surface dismissal', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const subscriptionSendBinary = vi.fn()
  const FATAL_ERROR = 'Remote terminal rejected the write: permission denied.'

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    subscriptionSendBinary.mockReset()
    runtimeCall.mockImplementation(async () => ({ ok: true, result: {} }))
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: { onResponse: (response: unknown) => void }) => {
        queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall,
          subscribe: runtimeSubscribe
        }
      }
    })
  })

  async function attachTransportWithFatalSends(onError: (message: string) => void) {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })
    transport.attach({ existingPtyId: 'remote:terminal-1', callbacks: { onError } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.send') {
        throw new Error(FATAL_ERROR)
      }
      return { ok: true, result: {} }
    })
    return transport
  }

  it('re-surfaces an identical fatal error after the user dismisses the error surface', async () => {
    const onError = vi.fn()
    const transport = await attachTransportWithFatalSends(onError)

    expect(await transport.sendInputAccepted?.('a')).toBe(false)
    expect(await transport.sendInputAccepted?.('b')).toBe(false)
    // Contract preserved: one continuous outage still surfaces the repeated error once.
    expect(onError.mock.calls).toEqual([[FATAL_ERROR]])

    transport.notifyErrorSurfaceDismissed?.()

    expect(await transport.sendInputAccepted?.('c')).toBe(false)
    expect(onError.mock.calls).toEqual([[FATAL_ERROR], [FATAL_ERROR]])

    // The memory re-arms: repeats after the re-surfaced error are suppressed again until the next dismissal.
    expect(await transport.sendInputAccepted?.('d')).toBe(false)
    expect(onError).toHaveBeenCalledTimes(2)
    transport.destroy?.()
  })

  it('leaves an undismissed surface deduped', async () => {
    const onError = vi.fn()
    const transport = await attachTransportWithFatalSends(onError)

    expect(await transport.sendInputAccepted?.('a')).toBe(false)
    expect(await transport.sendInputAccepted?.('b')).toBe(false)
    expect(await transport.sendInputAccepted?.('c')).toBe(false)

    expect(onError).toHaveBeenCalledTimes(1)
    transport.destroy?.()
  })
})
