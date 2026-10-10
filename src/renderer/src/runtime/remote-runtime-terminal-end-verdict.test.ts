import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RuntimeSubscriptionCallbacks = {
  onResponse: (response: unknown) => void
}

describe('remote runtime terminal end verdict', () => {
  let callbacks: RuntimeSubscriptionCallbacks | null = null

  beforeEach(() => {
    vi.resetModules()
    callbacks = null
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          subscribe: vi.fn(async (_args, nextCallbacks: RuntimeSubscriptionCallbacks) => {
            callbacks = nextCallbacks
            queueMicrotask(() => {
              callbacks?.onResponse({ ok: true, result: { type: 'ready' } })
            })
            return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
          })
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['an explicit host verdict', { verdict: 'exited' }, 'exited'],
    ['a legacy bare end', {}, 'unverifiable'],
    ['an unknown future verdict', { verdict: 'unknown' }, 'unverifiable']
  ])('maps %s to %s', async (_case, fields, expected) => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const onEnd = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('env-1').subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn(), onEnd }
    })

    callbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: stream.streamId, ...fields }
    })

    expect(onEnd).toHaveBeenCalledWith(expected)
  })
})
