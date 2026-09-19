import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

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
})
