import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// These transport fixtures never read abandoned-launch ownership from the app store.
const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

import { TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'
import type { PtyTransport } from './pty-transport-types'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, resetRemoteRuntimeTransport } = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

describe('createRemoteRuntimePtyTransport', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('retries an unknown terminal-create outcome exactly once with the same mutation id', async () => {
    let createCalls = 0
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) => {
      if (args.method === 'status.get') {
        return {
          ok: true,
          result: { capabilities: [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
        }
      }
      if (args.method === 'terminal.create') {
        createCalls += 1
        if (createCalls === 1) {
          throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
            code: 'runtime_timeout'
          })
        }
        return { ok: true, result: { terminal: { handle: 'terminal-once' } } }
      }
      return { ok: true, result: {} }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtySpawn = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtySpawn
    })

    await transport.connect({ url: '', callbacks: {} })

    const creates = runtimeCall.mock.calls
      .map(
        ([args]) =>
          args as {
            method: string
            params?: { clientMutationId?: string; reconcileExisting?: boolean }
          }
      )
      .filter((args) => args.method === 'terminal.create')
    expect(creates).toHaveLength(2)
    expect(creates[0].params?.clientMutationId).toMatch(/\S+/)
    expect(creates[1].params?.clientMutationId).toBe(creates[0].params?.clientMutationId)
    expect(creates[0].params?.reconcileExisting).toBeUndefined()
    expect(creates[1].params?.reconcileExisting).toBe(true)
    expect(onPtySpawn).toHaveBeenCalledTimes(1)
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-once')
    transport.destroy?.()
  })

  it('clips a reconciled create timeout to the budget left after a slow capability probe', async () => {
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      let createCalls = 0
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'status.get') {
          vi.setSystemTime(startedAt + REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS - 1_000)
          return {
            ok: true,
            result: { capabilities: [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
          }
        }
        if (args.method === 'terminal.create') {
          createCalls += 1
          if (createCalls === 1) {
            throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
              code: 'runtime_timeout'
            })
          }
          return { ok: true, result: { terminal: { handle: 'terminal-reconciled' } } }
        }
        return { ok: true, result: {} }
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

      const connect = transport.connect({ url: '', callbacks: {} })
      await vi.advanceTimersByTimeAsync(250)
      await connect

      const createRequests = runtimeCall.mock.calls
        .map(([args]) => args as { method: string; timeoutMs: number })
        .filter((args) => args.method === 'terminal.create')
      expect(createRequests).toHaveLength(2)
      expect(createRequests[1].timeoutMs).toBe(1_000)
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry an unknown create outcome against an older runtime', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        return { ok: true, result: { capabilities: [] } }
      }
      throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
        code: 'runtime_timeout'
      })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

    await transport.connect({ url: '', callbacks: { onError } })

    expect(
      runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.create')
    ).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    transport.destroy?.()
  })

  it('surfaces an authoritative capability-probe failure after an unknown create outcome', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        throw Object.assign(new Error('Remote runtime pairing credentials expired.'), {
          code: 'unauthorized'
        })
      }
      throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
        code: 'runtime_timeout'
      })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

    await transport.connect({ url: '', callbacks: { onError } })

    expect(onError).toHaveBeenCalledWith('Remote runtime pairing credentials expired.')
    expect(
      runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.create')
    ).toHaveLength(1)
    transport.destroy?.()
  })

  it('stops unknown terminal-create recovery at the cutoff and remains manually retryable', async () => {
    vi.useFakeTimers()
    try {
      let reachable = false
      let statusTimesOut = false
      runtimeCall.mockImplementation(async (args: { method: string; timeoutMs: number }) => {
        if (args.method === 'status.get') {
          if (statusTimesOut) {
            return new Promise((_, reject) => {
              setTimeout(() => {
                reject(
                  Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
                    code: 'runtime_timeout'
                  })
                )
              }, args.timeoutMs)
            })
          }
          return {
            ok: true,
            result: { capabilities: [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
          }
        }
        if (args.method === 'terminal.create' && reachable) {
          return { ok: true, result: { terminal: { handle: 'terminal-recovered' } } }
        }
        throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
          code: 'runtime_timeout'
        })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const recoveryStates: string[] = []
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

      const connect = transport.connect({
        url: '',
        callbacks: {
          onError,
          onRecoveryStateChange: (state) => recoveryStates.push(state.phase)
        }
      })
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      await connect
      const callsAtCutoff = runtimeCall.mock.calls.length

      expect(onError).not.toHaveBeenCalled()
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(recoveryStates).toContain('recovering')
      expect(runtimeCall.mock.calls.some(([args]) => args.method === 'terminal.create')).toBe(true)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(runtimeCall).toHaveBeenCalledTimes(callsAtCutoff)

      statusTimesOut = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      const callsAtManualCutoff = runtimeCall.mock.calls.length
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(runtimeCall).toHaveBeenCalledTimes(callsAtManualCutoff)

      statusTimesOut = false
      reachable = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-recovered'))
      const createRequests = runtimeCall.mock.calls
        .map(([args]) => args as { method: string; params?: { reconcileExisting?: boolean } })
        .filter((args) => args.method === 'terminal.create')
      expect(createRequests[0].params?.reconcileExisting).toBeUndefined()
      expect(createRequests.slice(1).every((args) => args.params?.reconcileExisting === true)).toBe(
        true
      )
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays an ambiguous structured agent create without downgrading after cutoff', async () => {
    vi.useFakeTimers()
    try {
      let reachable = false
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'status.get') {
          return {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        }
        if (args.method === 'terminal.createAgentSession' && reachable) {
          return {
            ok: true,
            result: {
              disposition: 'replayed',
              terminal: { handle: 'terminal-agent-recovered' }
            }
          }
        }
        throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
          code: 'runtime_timeout'
        })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        launchAgent: 'codex'
      })

      const connect = transport.connect({ url: '', callbacks: {} })
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      await connect

      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const initialCreates = runtimeCall.mock.calls
        .map(([args]) => args as { method: string; params?: { clientOperationId?: string } })
        .filter((args) => args.method === 'terminal.createAgentSession')
      expect(initialCreates.length).toBeGreaterThan(0)
      const operationId = initialCreates[0].params?.clientOperationId
      expect(operationId).toMatch(/\S+/)

      reachable = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() =>
        expect(transport.getPtyId()).toBe('remote:env-1@@terminal-agent-recovered')
      )

      const allCreates = runtimeCall.mock.calls
        .map(([args]) => args as { method: string; params?: { clientOperationId?: string } })
        .filter((args) => args.method === 'terminal.createAgentSession')
      expect(allCreates.every((args) => args.params?.clientOperationId === operationId)).toBe(true)
      expect(runtimeCall.mock.calls.some(([args]) => args.method === 'terminal.create')).toBe(false)
      expect(runtimeCall.mock.calls.filter(([args]) => args.method === 'status.get')).toHaveLength(
        1
      )
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses OMP thinking replay when the replacement host cannot preserve it', async () => {
    vi.useFakeTimers()
    let transport: PtyTransport | undefined
    try {
      let supportsThinking = true
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'status.get') {
          return {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: [
                'agent-session.host-authority.v1',
                ...(supportsThinking ? ['agent.launch.omp-thinking.v1'] : [])
              ]
            }
          }
        }
        throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
          code: 'runtime_timeout'
        })
      })
      // Reset modules gives each transport a fresh runtime capability cache.
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        launchAgent: 'omp',
        agentLaunchPreferences: { model: 'opus', effort: 'off' }
      })
      const connect = transport.connect({ url: '', callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      await connect
      const initialCreates = runtimeCall.mock.calls.filter(
        ([args]) => args.method === 'terminal.createAgentSession'
      ).length
      expect(initialCreates).toBeGreaterThan(0)

      supportsThinking = false
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() => expect(onError).toHaveBeenCalled())
      expect(
        runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.createAgentSession')
      ).toHaveLength(initialCreates)
      expect(runtimeCall.mock.calls.some(([args]) => args.method === 'terminal.create')).toBe(false)
      expect(transport.getPtyId()).toBeNull()
    } finally {
      transport?.destroy?.()
      vi.useRealTimers()
    }
  })

  it('refuses automatic OMP replay after pairing invalidates the first host capability', async () => {
    vi.useFakeTimers()
    let transport: PtyTransport | undefined
    try {
      // Each fixture reloads the transport and its production capability cache together.
      const { clearRuntimeCompatibilityCache } = await import('../../runtime/runtime-rpc-client')
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      let supportsThinking = true
      let creates = 0
      const operationIds: (string | undefined)[] = []
      runtimeCall.mockImplementation(
        async (args: { method: string; params?: { clientOperationId?: string } }) => {
          if (args.method === 'status.get') {
            return {
              ok: true,
              result: {
                runtimeProtocolVersion: 3,
                minCompatibleRuntimeClientVersion: 2,
                capabilities: [
                  'agent-session.host-authority.v1',
                  ...(supportsThinking ? ['agent.launch.omp-thinking.v1'] : [])
                ]
              }
            }
          }
          if (args.method === 'terminal.createAgentSession') {
            creates += 1
            operationIds.push(args.params?.clientOperationId)
            if (creates === 1) {
              supportsThinking = false
              clearRuntimeCompatibilityCache('env-1')
            } else {
              return {
                ok: true,
                result: {
                  disposition: 'replayed',
                  terminal: { handle: 'terminal-thinking-replayed' }
                }
              }
            }
          }
          throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
            code: 'runtime_timeout'
          })
        }
      )
      const onError = vi.fn()
      transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        launchAgent: 'omp',
        agentLaunchPreferences: { model: 'opus', effort: 'off' }
      })
      const connect = transport.connect({ url: '', callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      await connect

      expect(creates).toBe(1)
      expect(onError).toHaveBeenCalled()
      expect(runtimeCall.mock.calls.some(([args]) => args.method === 'terminal.create')).toBe(false)
      expect(transport.getPtyId()).toBeNull()

      supportsThinking = true
      clearRuntimeCompatibilityCache('env-1')
      expect(transport.retryRecovery?.()).toBe(true)
      const replayTransport = transport
      await vi.waitFor(() =>
        expect(replayTransport.getPtyId()).toBe('remote:env-1@@terminal-thinking-replayed')
      )
      expect(operationIds[0]).toMatch(/\S+/)
      expect(operationIds).toEqual([operationIds[0], operationIds[0]])
    } finally {
      transport?.destroy?.()
      vi.useRealTimers()
    }
  })

  it('refuses automatic legacy OMP create after thinking capability is invalidated', async () => {
    vi.useFakeTimers()
    let transport: PtyTransport | undefined
    try {
      // Pairing invalidation must affect the same production cache used by this transport.
      const { clearRuntimeCompatibilityCache } = await import('../../runtime/runtime-rpc-client')
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      let supportsThinking = true
      let creates = 0
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'status.get') {
          return {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: [
                TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
                ...(supportsThinking ? ['agent.launch.omp-thinking.v1'] : [])
              ]
            }
          }
        }
        if (args.method === 'terminal.create') {
          creates += 1
          if (creates === 1) {
            supportsThinking = false
            clearRuntimeCompatibilityCache('env-1')
            throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
              code: 'runtime_timeout'
            })
          }
          return { ok: true, result: { terminal: { handle: 'incorrect-legacy-create' } } }
        }
        return { ok: true, result: {} }
      })
      const onError = vi.fn()
      transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        launchAgent: 'omp',
        agentLaunchPreferences: { model: 'opus', effort: 'off' }
      })
      const connect = transport.connect({ url: '', callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      await connect
      expect(creates).toBe(1)
      expect(onError).toHaveBeenCalled()
      expect(transport.getPtyId()).toBeNull()
    } finally {
      transport?.destroy?.()
      vi.useRealTimers()
    }
  })

  it.each(['host-authority', 'legacy'] as const)(
    'does not invent uncertain %s creation when only the thinking preflight times out',
    async (lane) => {
      vi.useFakeTimers()
      let transport: PtyTransport | undefined
      try {
        let statusCalls = 0
        const creates: { method: string; params?: { reconcileExisting?: boolean } }[] = []
        runtimeCall.mockImplementation(
          async (args: { method: string; params?: { reconcileExisting?: boolean } }) => {
            if (args.method === 'status.get') {
              statusCalls += 1
              if (statusCalls > 1) {
                throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
                  code: 'runtime_timeout'
                })
              }
              return {
                ok: true,
                result: {
                  runtimeProtocolVersion: 3,
                  minCompatibleRuntimeClientVersion: 2,
                  capabilities: [
                    'agent.launch.omp-thinking.v1',
                    TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
                    ...(lane === 'host-authority' ? ['agent-session.host-authority.v1'] : [])
                  ]
                }
              }
            }
            if (
              args.method === 'terminal.create' ||
              args.method === 'terminal.createAgentSession'
            ) {
              creates.push(args)
              return { ok: true, result: { terminal: { handle: 'terminal-after-preflight' } } }
            }
            return { ok: true, result: {} }
          }
        )
        // Reloaded transport and capability cache are paired by the fixture.
        const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
        transport = createRemoteRuntimePtyTransport('env-1', {
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: 'pane:1',
          launchAgent: 'omp',
          terminalKittyKeyboardProtocol: true,
          agentLaunchPreferences: { model: 'opus', effort: 'off' }
        })
        const options = { url: '', callbacks: {} }
        const first = transport.connect(options)
        await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
        await first
        expect(creates).toEqual([])
        expect(transport.retryRecovery?.()).toBe(false)
      } finally {
        transport?.destroy?.()
        vi.useRealTimers()
      }
    }
  )
})
