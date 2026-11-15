import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyTransport, PtyTransportRecoveryState } from '../pty-transport-types'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'
import './recovery/remote-runtime-pty-recovery-state'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './recovery/remote-runtime-pty-recovery-limits'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'
let transport: PtyTransport | undefined

const {
  runtimeCall,
  runtimeSubscribe,
  latestSubscribePayload,
  subscribedTerminalHandles,
  emitSnapshot,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

const pendingErrors = [
  { name: 'awaiting sign-in', message: 'SSH host needs you to sign in. Reconnect to sign in.' },
  {
    name: 'IPC-wrapped sign-in',
    message:
      "Error invoking remote method 'runtimeEnvironments:call': Error: SSH host needs you to sign in. Reconnect to sign in."
  },
  {
    name: 'cancelled sign-in',
    message: 'SSH sign-in for SSH host was cancelled. Reconnect to sign in again.'
  },
  { name: 'connection in progress', message: 'Connection to SSH host is already in progress' }
]

beforeEach(() => {
  vi.useFakeTimers()
  resetRemoteRuntimeTransport()
  resolvedPaneHandle = 'terminal-existing'
})

afterEach(() => {
  transport?.destroy?.()
  transport = undefined
  vi.useRealTimers()
  expect(appStore.getState).not.toHaveBeenCalled()
})

async function mountNewPaneAwaitingSignIn(failure: { message: string }, afterSignIn?: () => void) {
  let signedIn = false
  const healthyCall = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
    if (!signedIn) {
      throw new Error(failure.message)
    }
    afterSignIn?.()
    return healthyCall?.(request)
  })
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  await import('./recovery/remote-runtime-pty-recovery-state')
  const { reviveRemoteRuntimePtyRecoveriesForEnvironment } =
    await import('./recovery/remote-runtime-pty-control-ready-revivers')
  const onError = vi.fn()
  const onPtySpawn = vi.fn()
  const publishedStates: PtyTransportRecoveryState[] = []
  const pane = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-new',
    leafId: 'pane:1',
    onPtySpawn
  })
  transport = pane
  let connectSettled = false
  const connected = Promise.resolve(
    pane.connect({
      url: '',
      cols: 80,
      rows: 24,
      callbacks: { onError, onRecoveryStateChange: (state) => publishedStates.push(state) }
    })
  ).finally(() => {
    connectSettled = true
  })
  await vi.advanceTimersByTimeAsync(0)
  return {
    connected,
    connectSettled: () => connectSettled,
    pane,
    lastPublishedState: () => publishedStates.at(-1),
    onError,
    onPtySpawn,
    createCalls: () =>
      runtimeCall.mock.calls.filter(([request]) => request.method === 'terminal.create'),
    signIn: () => {
      signedIn = true
      return reviveRemoteRuntimePtyRecoveriesForEnvironment('env-1')
    }
  }
}

describe('SSH sign-in for a terminal created while the host waits for sign-in', () => {
  it('settles the original spawn when the stream, not the create, waited for sign-in', async () => {
    resolvedPaneHandle = 'terminal-1'
    let signedIn = false
    const healthySubscribe = runtimeSubscribe.getMockImplementation()
    runtimeSubscribe.mockImplementation(async (...args: unknown[]) => {
      if (!signedIn) {
        throw new Error(pendingErrors[0].message)
      }
      return healthySubscribe?.(...args)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    await import('./recovery/remote-runtime-pty-recovery-state')
    const { reviveRemoteRuntimePtyRecoveriesForEnvironment } =
      await import('./recovery/remote-runtime-pty-control-ready-revivers')
    const onPtySpawn = vi.fn()
    const pane = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-new',
      leafId: 'pane:1',
      onPtySpawn
    })
    transport = pane
    const connected = Promise.resolve(pane.connect({ url: '', cols: 80, rows: 24, callbacks: {} }))
    await vi.advanceTimersByTimeAsync(0)
    expect(pane.getRecoveryState?.().reason).toBe('ssh-sign-in')

    signedIn = true
    expect(reviveRemoteRuntimePtyRecoveriesForEnvironment('env-1')).toBe(1)
    await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
    const { streamId } = latestSubscribePayload()
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
    emitSnapshot(streamId, 'fresh prompt$ ')

    await expect(connected).resolves.toMatchObject({ id: 'remote:env-1@@terminal-1' })
    expect(onPtySpawn).toHaveBeenCalledTimes(1)
  })

  it.each(['destroy', 'disconnect'] as const)(
    'spawns nothing after sign-in once the pending terminal is closed (%s)',
    async (teardown) => {
      const { pane, onPtySpawn, signIn, createCalls, connected } = await mountNewPaneAwaitingSignIn(
        pendingErrors[0]
      )
      const createsBeforeClose = createCalls().length
      pane[teardown]?.()
      await expect(connected).resolves.toBeUndefined()

      expect(signIn()).toBe(0)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)

      expect(createCalls()).toHaveLength(createsBeforeClose)
      expect(onPtySpawn).not.toHaveBeenCalled()
      expect(subscribedTerminalHandles()).toEqual([])
    }
  )
})
