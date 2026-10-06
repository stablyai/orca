import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchRuntimeControlReconnect } from './runtime-control-reconnect-watch'

type DiagnosticsListener = (event: {
  environmentId: string
  diagnostics: { state: string }
}) => void

function stubDiagnostics(): { emit: (environmentId: string, state: string) => void } {
  const listeners = new Set<DiagnosticsListener>()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        onSharedControlDiagnostics: (listener: DiagnosticsListener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
  return {
    emit: (environmentId, state) => {
      for (const listener of listeners) {
        listener({ environmentId, diagnostics: { state } })
      }
    }
  }
}

describe('watchRuntimeControlReconnect', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('resolves on a not-ready to ready transition for its environment', async () => {
    const { emit } = stubDiagnostics()
    const watch = watchRuntimeControlReconnect('env-1')
    const reconnected = watch.reconnected(30_000)
    emit('env-2', 'awaiting_ready')
    emit('env-2', 'ready')
    emit('env-1', 'closed')
    emit('env-1', 'awaiting_ready')
    emit('env-1', 'ready')
    await expect(reconnected).resolves.toBe(true)
    watch.dispose()
  })

  it('ignores ready republished on a socket that never dropped', async () => {
    vi.useFakeTimers()
    const { emit } = stubDiagnostics()
    const watch = watchRuntimeControlReconnect('env-1')
    const reconnected = watch.reconnected(1_000)
    emit('env-1', 'ready')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(reconnected).resolves.toBe(false)
    watch.dispose()
  })

  it('remembers a reconnect that happened before the wait began', async () => {
    const { emit } = stubDiagnostics()
    const watch = watchRuntimeControlReconnect('env-1')
    emit('env-1', 'awaiting_ready')
    emit('env-1', 'ready')
    await expect(watch.reconnected(30_000)).resolves.toBe(true)
    watch.dispose()
  })

  it('does not wait where the bridge has no diagnostics feed', async () => {
    vi.stubGlobal('window', { api: { runtimeEnvironments: {} } })
    const watch = watchRuntimeControlReconnect('env-1')
    await expect(watch.reconnected(30_000)).resolves.toBe(false)
    watch.dispose()
  })
})
