import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import type { PtyTransportRecoveryState } from './pty-transport-types'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, resetRemoteRuntimeTransport, subscribedTerminalHandles } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

const HOST_SURFACE_ATTACH_WINDOW_MS = 15_000

function hostSessionSnapshot(status: 'pending-handle' | 'ready' | 'absent'): unknown {
  return {
    worktree: 'id:wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'host-tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs:
      status === 'absent'
        ? []
        : [
            {
              type: 'terminal',
              id: 'host-tab-1::leaf-1',
              parentTabId: 'host-tab-1',
              leafId: 'leaf-1',
              title: 'Terminal 1',
              isActive: true,
              status,
              terminal: status === 'ready' ? 'terminal-1' : null
            }
          ]
  }
}

function respondWithPendingHostSurface(args: { method: string }): Promise<unknown> {
  if (args.method === 'session.tabs.activate' || args.method === 'session.tabs.list') {
    return Promise.resolve({ ok: true, result: hostSessionSnapshot('pending-handle') })
  }
  return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
}

function countCalls(method: string): number {
  return runtimeCall.mock.calls.filter((call) => call[0].method === method).length
}

function hostSurfaceRequestBudgets(): number[] {
  return runtimeCall.mock.calls
    .filter(
      (call) => call[0].method === 'session.tabs.list' || call[0].method === 'session.tabs.activate'
    )
    .map((call) => call[0].timeoutMs as number)
}

describe('initial host-mirror attach against a surface published as pending-handle', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps re-activating a surface the host never materializes', async () => {
    runtimeCall.mockImplementation(respondWithPendingHostSurface)
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.advanceTimersByTimeAsync(HOST_SURFACE_ATTACH_WINDOW_MS)
    await expect(connect).resolves.toBeUndefined()

    expect(countCalls('session.tabs.activate')).toBeGreaterThan(1)
  })

  it('ends the bounded wait in a revivable recovery epoch, never stranded in connecting', async () => {
    runtimeCall.mockImplementation(respondWithPendingHostSurface)
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } =
      await import('./remote-runtime-pty-recovery-state')
    const recoveryStates: PtyTransportRecoveryState[] = []
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({
      url: '',
      callbacks: {
        onRecoveryStateChange: (state) => {
          recoveryStates.push(state)
        }
      }
    })
    await vi.advanceTimersByTimeAsync(HOST_SURFACE_ATTACH_WINDOW_MS)
    await expect(connect).resolves.toBeUndefined()

    expect(transport.getRecoveryState?.().phase).toBe('recovering')
    expect(recoveryStates.at(-1)?.phase).toBe('recovering')

    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)

    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    expect(transport.retryRecovery?.()).toBe(true)
  })

  it('leaves a reattached pane recoverable when the relaunched host never materializes it', async () => {
    runtimeCall.mockImplementation(respondWithPendingHostSurface)
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } =
      await import('./remote-runtime-pty-recovery-state')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@stale-client-handle',
      cols: 100,
      rows: 30,
      callbacks: {}
    })
    await vi.advanceTimersByTimeAsync(
      HOST_SURFACE_ATTACH_WINDOW_MS + REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS
    )

    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    expect(transport.retryRecovery?.()).toBe(true)
  })

  it('revives a given-up pane when network online or system resume fires', async () => {
    let hostMaterialized = false
    runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'session.tabs.activate' || args.method === 'session.tabs.list') {
        return Promise.resolve({
          ok: true,
          result: hostSessionSnapshot(hostMaterialized ? 'ready' : 'pending-handle')
        })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS, retryAllRemoteRuntimePtyRecoveriesNow } =
      await import('./remote-runtime-pty-recovery-state')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.advanceTimersByTimeAsync(
      HOST_SURFACE_ATTACH_WINDOW_MS + REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS
    )
    await expect(connect).resolves.toBeUndefined()
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')

    hostMaterialized = true
    expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(subscribedTerminalHandles()).toContain('terminal-1')
    expect(transport.getPtyId?.()).toBe('remote:env-1@@terminal-1')
  })

  it('concludes absence from list inventory only, never from an activation snapshot', async () => {
    runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'session.tabs.activate') {
        return Promise.resolve({ ok: true, result: hostSessionSnapshot('absent') })
      }
      if (args.method === 'session.tabs.list') {
        return Promise.resolve({ ok: true, result: hostSessionSnapshot('pending-handle') })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({ url: '', callbacks: { onError } })
    await vi.advanceTimersByTimeAsync(HOST_SURFACE_ATTACH_WINDOW_MS)
    await expect(connect).resolves.toBeUndefined()

    expect(onError).not.toHaveBeenCalled()
    expect(countCalls('session.tabs.activate')).toBeGreaterThan(1)
    expect(transport.getRecoveryState?.().phase).toBe('recovering')
  })

  it('never reads an empty tab inventory as a closed remote terminal', async () => {
    let hostRepublished = false
    runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'session.tabs.activate' || args.method === 'session.tabs.list') {
        return Promise.resolve({
          ok: true,
          result: hostSessionSnapshot(hostRepublished ? 'ready' : 'absent')
        })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({ url: '', callbacks: { onError } })
    await vi.advanceTimersByTimeAsync(1_000)

    // A snapshot with no surface for the tab is a client-side view of a host that may still be
    // republishing — unknown liveness, so no terminal-closed verdict may be surfaced.
    expect(onError).not.toHaveBeenCalled()

    hostRepublished = true
    await vi.advanceTimersByTimeAsync(HOST_SURFACE_ATTACH_WINDOW_MS)
    await expect(connect).resolves.toMatchObject({ id: 'remote:env-1@@terminal-1' })

    expect(onError).not.toHaveBeenCalled()
    expect(subscribedTerminalHandles()).toContain('terminal-1')
  })

  it('keeps a pane whose tab inventory stayed empty revivable instead of latching an error', async () => {
    runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'session.tabs.activate' || args.method === 'session.tabs.list') {
        return Promise.resolve({ ok: true, result: hostSessionSnapshot('absent') })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } =
      await import('./remote-runtime-pty-recovery-state')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({ url: '', callbacks: { onError } })
    await vi.advanceTimersByTimeAsync(
      HOST_SURFACE_ATTACH_WINDOW_MS + REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS
    )
    await expect(connect).resolves.toBeUndefined()

    expect(onError).not.toHaveBeenCalled()
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    expect(transport.retryRecovery?.()).toBe(true)
  })

  it('stops re-activating once an activation outcome is unobservable', async () => {
    let activations = 0
    runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'session.tabs.activate') {
        activations += 1
        return Promise.resolve(
          activations > 1
            ? {
                ok: false,
                error: {
                  code: 'remote_runtime_unavailable',
                  message: 'Remote Orca runtime connection closed'
                }
              }
            : { ok: true, result: hostSessionSnapshot('pending-handle') }
        )
      }
      if (args.method === 'session.tabs.list') {
        return Promise.resolve({ ok: true, result: hostSessionSnapshot('pending-handle') })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.advanceTimersByTimeAsync(HOST_SURFACE_ATTACH_WINDOW_MS)
    await expect(connect).resolves.toBeUndefined()

    // Why: the failed activation may still have minted a host PTY, so replaying it would duplicate the shell.
    expect(activations).toBe(2)
    expect(countCalls('session.tabs.list')).toBeGreaterThan(2)
  })

  it('bounds every in-loop request by the remaining attach budget', async () => {
    runtimeCall.mockImplementation(respondWithPendingHostSurface)
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.advanceTimersByTimeAsync(HOST_SURFACE_ATTACH_WINDOW_MS)
    await expect(connect).resolves.toBeUndefined()

    const budgets = hostSurfaceRequestBudgets().slice(1)
    expect(budgets.length).toBeGreaterThan(1)
    expect(Math.max(...budgets)).toBeLessThan(HOST_SURFACE_ATTACH_WINDOW_MS)
    expect(budgets.at(-1)).toBeLessThan(2_000)
  })

  it('attaches once a re-activation materializes the relaunched host surface', async () => {
    let activations = 0
    runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'session.tabs.activate') {
        activations += 1
        return Promise.resolve({
          ok: true,
          result: hostSessionSnapshot(activations > 1 ? 'ready' : 'pending-handle')
        })
      }
      if (args.method === 'session.tabs.list') {
        return Promise.resolve({
          ok: true,
          result: hostSessionSnapshot('pending-handle')
        })
      }
      return Promise.resolve({
        ok: true,
        result: { terminal: { handle: 'duplicate-terminal' } }
      })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(connect).resolves.toMatchObject({
      id: 'remote:env-1@@terminal-1'
    })
    expect(countCalls('terminal.create')).toBe(0)
  })
})
