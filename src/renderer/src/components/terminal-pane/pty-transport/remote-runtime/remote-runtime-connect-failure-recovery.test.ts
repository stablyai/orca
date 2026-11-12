import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'
import './recovery/remote-runtime-pty-recovery-state'
import {
  REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS,
  REMOTE_RUNTIME_RECOVERY_ATTEMPT_BUDGET_MS
} from './recovery/remote-runtime-pty-recovery-limits'
import { createCompatibleRuntimeStatusResponse } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'

const appStore = vi.hoisted(() => ({
  getState: vi.fn<() => { runtimeStatusByEnvironmentId: Map<string, unknown> }>(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

let freshLaunchFixture = false
afterEach(() => {
  if (!freshLaunchFixture) {
    expect(appStore.getState).not.toHaveBeenCalled()
  }
})

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

// Recoverable connect errors must retain backoff or parked retry so online/resume and Reconnect can revive the pane (#12684).
describe('recoverable connect failures on a remote runtime pane', () => {
  let resolvePaneCalls = 0

  function installUnreachableRuntime(): void {
    resolvePaneCalls = 0
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.resolvePane') {
        resolvePaneCalls += 1
      }
      throw Object.assign(new Error('Remote Orca runtime closed the connection.'), {
        code: 'remote_runtime_unavailable'
      })
    })
  }

  // Delay failure through the real RPC budget to cover rejection after the recovery deadline, unlike immediate mock rejection.
  function installSilentlyDroppedRuntime(): void {
    resolvePaneCalls = 0
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.resolvePane') {
        resolvePaneCalls += 1
      }
      await new Promise((resolve) => {
        setTimeout(resolve, REMOTE_RUNTIME_RECOVERY_ATTEMPT_BUDGET_MS)
      })
      throw Object.assign(new Error('Remote Orca runtime closed the connection.'), {
        code: 'remote_runtime_unavailable'
      })
    })
  }

  beforeEach(() => {
    resetRemoteRuntimeTransport()
    freshLaunchFixture = false
    appStore.getState.mockReset().mockImplementation(() => {
      throw new Error('These transport fixtures must not read app-store ownership')
    })
  })

  it('re-prepares a fresh agent after a failed capability read through scheduled recovery', async () => {
    vi.useFakeTimers()
    freshLaunchFixture = true
    appStore.getState.mockReturnValue({ runtimeStatusByEnvironmentId: new Map() })
    const hostCall = runtimeCall.getMockImplementation()
    let statusReads = 0
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method !== 'status.get') {
        return hostCall?.(request)
      }
      statusReads++
      if (statusReads === 2) {
        throw Object.assign(new Error('Remote Orca runtime closed the connection.'), {
          code: 'remote_runtime_unavailable'
        })
      }
      const status = createCompatibleRuntimeStatusResponse('runtime-remote')
      if (statusReads === 1) {
        status.result.capabilities = status.result.capabilities?.filter(
          (capability) => capability !== 'agent-session.keyboard.v1'
        )
      }
      return status
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-fresh',
      leafId: 'pane:1',
      launchAgent: 'claude',
      terminalKittyKeyboardProtocol: true,
      freshAgentLaunch: { prompt: '', promptDelivery: 'auto-submit' }
    })
    try {
      await transport.connect({ url: '', callbacks: {} })
      expect(
        runtimeCall.mock.calls.some(([request]) => request.method.startsWith('terminal.create'))
      ).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1'))
      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'terminal.createAgentSession'
        )
      ).toEqual([
        [expect.objectContaining({ params: expect.objectContaining({ agent: 'claude' }) })]
      ])
      expect(runtimeCall.mock.calls.some(([request]) => request.method === 'terminal.create')).toBe(
        false
      )
    } finally {
      transport.destroy?.()
      vi.useRealTimers()
    }
  })

  it('leaves both revival paths armed once the recovery window is spent', async () => {
    vi.useFakeTimers()
    try {
      installUnreachableRuntime()
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      // Import dynamically after module reset so transport and retry registry share one instance.
      const { retryAllRemoteRuntimePtyRecoveriesNow } =
        await import('./recovery/remote-runtime-pty-recovery-state')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', sessionId: 'remote:env-1@@', callbacks: {} })
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)

      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const callsAtCutoff = resolvePaneCalls

      // The cutoff stops self-initiated retries only; online/resume must still find a parked retry.
      expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(resolvePaneCalls).toBeGreaterThan(callsAtCutoff)

      // ...and so must the Reconnect button, which returned false before #12684.
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(transport.retryRecovery?.()).toBe(true)

      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps the window bounded when a silent drop fails after the deadline latched', async () => {
    vi.useFakeTimers()
    try {
      installSilentlyDroppedRuntime()
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      void transport.connect({ url: '', sessionId: 'remote:env-1@@', callbacks: {} })
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS * 2)

      // The in-flight rejection must not begin a new epoch; that re-arms a full-length window forever.
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const callsAtCutoff = resolvePaneCalls
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS * 2)
      expect(resolvePaneCalls).toBe(callsAtCutoff)

      // A deadline that lands mid-attempt parks nothing, so the latch must still stay revivable.
      expect(transport.retryRecovery?.()).toBe(true)

      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
