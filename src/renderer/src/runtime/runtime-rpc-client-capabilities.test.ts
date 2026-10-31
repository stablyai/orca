import { describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  clearRecentRuntimeCompatibilityFailure,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import {
  installRuntimeRpcClientTestBridge,
  runtimeEnvironmentCall
} from './runtime-rpc-client-test-bridge'

installRuntimeRpcClientTestBridge()

describe('runtime RPC capability compatibility', () => {
  it('checks advertised runtime capabilities after protocol compatibility', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'remote-runtime',
        graphStatus: 'ready',
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
        capabilities: ['project-host-setup.v1']
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      assertRuntimeEnvironmentCapability(
        'env-1',
        'project-host-setup.v1',
        'Project setup is unavailable.'
      )
    ).resolves.toBeUndefined()
  })

  it('re-probes capability support after a failed compatibility cache entry', async () => {
    let statusCalls = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        statusCalls += 1
        if (statusCalls === 1) {
          return Promise.resolve({
            id: 'status',
            ok: false,
            error: { code: 'runtime_unavailable', message: 'offline' },
            _meta: { runtimeId: 'remote-runtime' }
          })
        }
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'remote-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: ['linear.issue-attribute-filter.v1']
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })
    const target = { kind: 'environment', environmentId: 'env-cap-recover' } as const

    await expect(callRuntimeRpc(target, 'repo.list')).rejects.toThrow('offline')
    await expect(
      runtimeEnvironmentSupportsCapability('env-cap-recover', 'linear.issue-attribute-filter.v1')
    ).resolves.toBe(true)
    expect(statusCalls).toBe(2)
  })

  it('re-probes a missing capability on retry so a runtime upgrade can recover', async () => {
    let statusCalls = 0
    runtimeEnvironmentCall.mockImplementation(() => {
      statusCalls += 1
      return Promise.resolve({
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'remote-runtime',
          graphStatus: 'ready',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: statusCalls === 1 ? [] : ['linear.issue-attribute-filter.v1']
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await expect(
      runtimeEnvironmentSupportsCapability('env-cap-upgrade', 'linear.issue-attribute-filter.v1')
    ).resolves.toBe(false)
    await expect(
      runtimeEnvironmentSupportsCapability('env-cap-upgrade', 'linear.issue-attribute-filter.v1')
    ).resolves.toBe(true)
    expect(statusCalls).toBe(2)
  })

  it('dispatches capability-selected legacy without a redundant status probe', async () => {
    const methods: string[] = []
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      methods.push(method)
      if (method === 'status.get') {
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'old-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: []
          },
          _meta: { runtimeId: 'old-runtime' }
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: { terminal: { handle: 'legacy' } },
        _meta: { runtimeId: 'old-runtime' }
      })
    })
    const target = { kind: 'environment', environmentId: 'env-legacy' } as const

    await expect(
      runtimeEnvironmentSupportsCapability('env-legacy', 'agent-session.host-authority.v1')
    ).resolves.toBe(false)
    await callRuntimeRpc(target, 'terminal.create', {}, { skipCompatibilityCheck: true })

    expect(methods).toEqual(['status.get', 'terminal.create'])
  })

  it('coalesces concurrent cold-cache capability probes onto one status.get', async () => {
    let statusCalls = 0
    runtimeEnvironmentCall.mockImplementation(() => {
      statusCalls += 1
      return Promise.resolve({
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'remote-runtime',
          graphStatus: 'ready',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: ['linear.issue-attribute-filter.v1']
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    const [a, b, c] = await Promise.all([
      runtimeEnvironmentSupportsCapability(
        'env-cap-concurrent',
        'linear.issue-attribute-filter.v1'
      ),
      runtimeEnvironmentSupportsCapability(
        'env-cap-concurrent',
        'linear.issue-attribute-filter.v1'
      ),
      runtimeEnvironmentSupportsCapability('env-cap-concurrent', 'linear.issue-attribute-filter.v1')
    ])

    expect([a, b, c]).toEqual([true, true, true])
    expect(statusCalls).toBe(1)
  })

  it('expires a supported capability verdict so a runtime downgrade is detected', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    try {
      let statusCalls = 0
      runtimeEnvironmentCall.mockImplementation(() => {
        statusCalls += 1
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'remote-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: statusCalls === 1 ? ['linear.issue-attribute-filter.v1'] : []
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      })

      await expect(
        runtimeEnvironmentSupportsCapability(
          'env-cap-downgrade',
          'linear.issue-attribute-filter.v1'
        )
      ).resolves.toBe(true)
      vi.setSystemTime(new Date(59_999))
      await expect(
        runtimeEnvironmentSupportsCapability(
          'env-cap-downgrade',
          'linear.issue-attribute-filter.v1'
        )
      ).resolves.toBe(true)
      vi.setSystemTime(new Date(60_000))
      await expect(
        runtimeEnvironmentSupportsCapability(
          'env-cap-downgrade',
          'linear.issue-attribute-filter.v1'
        )
      ).resolves.toBe(false)
      expect(statusCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates a positive capability verdict when the endpoint runtime changes', async () => {
    let statusCalls = 0
    runtimeEnvironmentCall.mockImplementation(() => {
      statusCalls += 1
      const runtimeId = statusCalls === 1 ? 'runtime-before-restart' : 'runtime-after-restart'
      return Promise.resolve({
        id: 'status',
        ok: true,
        result: {
          runtimeId,
          graphStatus: 'ready',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: statusCalls === 1 ? ['agent-session.host-authority.v1'] : []
        },
        _meta: { runtimeId }
      })
    })

    await expect(
      runtimeEnvironmentSupportsCapability(
        'env-runtime-replaced',
        'agent-session.host-authority.v1'
      )
    ).resolves.toBe(true)
    clearRecentRuntimeCompatibilityFailure('env-runtime-replaced', {
      runtimeId: 'runtime-after-restart',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    } as RuntimeStatus)
    await expect(
      runtimeEnvironmentSupportsCapability(
        'env-runtime-replaced',
        'agent-session.host-authority.v1'
      )
    ).resolves.toBe(false)
    expect(statusCalls).toBe(2)
  })

  it('rejects missing advertised runtime capabilities with the caller message', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'remote-runtime',
        graphStatus: 'ready',
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
        capabilities: []
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      assertRuntimeEnvironmentCapability(
        'env-1',
        'project-host-setup.v1',
        'Project setup is unavailable.'
      )
    ).rejects.toThrow('Project setup is unavailable.')
  })
})
