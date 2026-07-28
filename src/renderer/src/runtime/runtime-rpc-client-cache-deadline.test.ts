import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS } from '../../../shared/terminal-tab-close'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(0))
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentCall }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("bounds a cached compatibility probe by the close caller's deadline", async () => {
  let resolveStatus!: (value: unknown) => void
  const pendingStatus = new Promise((resolve) => {
    resolveStatus = resolve
  })
  runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
    if (method === 'status.get') {
      return pendingStatus
    }
    return Promise.resolve({
      id: method,
      ok: true,
      result: { closed: true },
      _meta: { runtimeId: 'runtime-1' }
    })
  })
  const target = { kind: 'environment', environmentId: 'env-shared-probe' } as const
  const longProbe = callRuntimeRpc(target, 'repo.list', undefined, { timeoutMs: 60_000 })
  const close = callRuntimeRpc(target, 'session.tabs.close')
  let closeOutcome = 'pending'
  const observedClose = close.then(
    () => {
      closeOutcome = 'resolved'
    },
    (error: Error) => {
      closeOutcome = error.message
    }
  )

  await vi.advanceTimersByTimeAsync(TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS)
  const outcomeAtDeadline = closeOutcome
  resolveStatus({
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'runtime-1',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    },
    _meta: { runtimeId: 'runtime-1' }
  })
  await Promise.allSettled([longProbe, observedClose])

  expect(outcomeAtDeadline).toBe('Runtime compatibility check timed out')
})
