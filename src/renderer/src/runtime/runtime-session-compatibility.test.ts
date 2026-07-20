import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { subscribeRuntimeRpc } from './runtime-subscription-client'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentSubscribe = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentSubscribe.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: runtimeEnvironmentCall,
        subscribe: runtimeEnvironmentSubscribe
      }
    }
  })
})

describe('runtime session compatibility fence', () => {
  it('blocks saved-runtime subscriptions before opening an incompatible stream', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'remote-runtime',
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION - 1,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION - 1
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      subscribeRuntimeRpc(
        { selector: 'saved-env', method: 'session.tabs.subscribeAll', params: {} },
        { onResponse: vi.fn() }
      )
    ).rejects.toThrow('too old for this client')

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'saved-env',
      method: 'status.get',
      timeoutMs: undefined
    })
    expect(runtimeEnvironmentSubscribe).not.toHaveBeenCalled()
  })

  it('rechecks destructive calls after a cached host rollback', async () => {
    let statusProtocol = RUNTIME_PROTOCOL_VERSION
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'remote-runtime',
            runtimeProtocolVersion: statusProtocol,
            minCompatibleRuntimeClientVersion: statusProtocol
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: {},
        _meta: { runtimeId: 'remote-runtime' }
      })
    })
    const target = { kind: 'environment' as const, environmentId: 'saved-env' }

    await expect(callRuntimeRpc(target, 'repo.list')).resolves.toEqual({})
    statusProtocol = RUNTIME_PROTOCOL_VERSION - 1
    await expect(
      callRuntimeRpc(
        target,
        'terminal.close',
        { terminal: 'stale-terminal' },
        {
          forceCompatibilityRefresh: true
        }
      )
    ).rejects.toThrow('too old for this client')

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'repo.list',
      'status.get'
    ])
  })

  it('coalesces concurrent fresh probes for destructive bulk closes', async () => {
    let resolveStatus!: (response: unknown) => void
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        return new Promise((resolve) => {
          resolveStatus = resolve
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: {},
        _meta: { runtimeId: 'remote-runtime' }
      })
    })
    const target = { kind: 'environment' as const, environmentId: 'bulk-env' }
    const options = { forceCompatibilityRefresh: true }

    const first = callRuntimeRpc(target, 'terminal.close', { terminal: 'one' }, options)
    const second = callRuntimeRpc(target, 'terminal.closeTab', { terminal: 'two' }, options)
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    resolveStatus({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'remote-runtime',
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}])
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'terminal.close',
      'terminal.closeTab'
    ])
  })
})
