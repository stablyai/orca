import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyTransport } from './pty-transport-types'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'
let transport: PtyTransport | undefined

const {
  runtimeCall,
  latestSubscribePayload,
  subscribedTerminalHandles,
  emitSnapshot,
  emitOutput,
  inputFrameTexts,
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

async function mountAwaitingPane(tabId: string, failure: { message: string; code?: string }) {
  let signedIn = false
  const healthyCall = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
    if (!signedIn) {
      throw Object.assign(new Error(failure.message), failure.code ? { code: failure.code } : {})
    }
    if (request.method === 'session.tabs.list') {
      return readyHostSessionInventoryResponse('terminal-existing')
    }
    return healthyCall?.(request)
  })
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const { reviveRemoteRuntimePtyRecoveriesForEnvironment } =
    await import('./remote-runtime-pty-recovery-state')
  const onData = vi.fn()
  const onError = vi.fn()
  const pane = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId,
    leafId: 'pane:1'
  })
  transport = pane
  pane.attach({
    existingPtyId: 'remote:env-1@@terminal-existing',
    cols: 80,
    rows: 24,
    callbacks: { onData, onError }
  })
  await vi.advanceTimersByTimeAsync(0)
  return {
    pane,
    onData,
    onError,
    signIn: () => {
      signedIn = true
      return reviveRemoteRuntimePtyRecoveriesForEnvironment('env-1')
    }
  }
}

describe.each([
  { name: 'restored pane', tabId: 'tab-1' },
  { name: 'host mirror', tabId: 'web-terminal-host-tab-1' }
])('SSH sign-in recovery for a $name', ({ tabId }) => {
  it.each(
    pendingErrors.flatMap((failure) =>
      [false, true].map((late) => ({
        ...failure,
        late,
        timing: late ? 'after the recovery deadline' : 'before the recovery deadline'
      }))
    )
  )('restores original-terminal I/O for $name $timing', async (failure) => {
    const { pane, onData, onError, signIn } = await mountAwaitingPane(tabId, failure)
    expect(pane.getRecoveryState?.().phase).toBe('backoff')
    expect(subscribedTerminalHandles()).toEqual([])

    if (failure.late) {
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)
      expect(pane.getRecoveryState?.().phase).toBe('disconnected')
    }

    expect(signIn()).toBe(1)
    await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-existing'))
    const { streamId } = latestSubscribePayload()
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
    emitSnapshot(streamId, 'restored prompt$ ')
    emitOutput(streamId, 'resumed output\r\n', 4)

    expect(pane.isConnected()).toBe(true)
    expect(pane.getPtyId()).toBe('remote:env-1@@terminal-existing')
    expect(onData).toHaveBeenCalledWith('resumed output\r\n', expect.any(Object))
    expect(pane.sendInputImmediate('echo recovered\r')).toBe(true)
    expect(inputFrameTexts()).toEqual(['echo recovered\r'])
    expect(onError).not.toHaveBeenCalled()
    expect(
      runtimeCall.mock.calls.filter(([request]) => request.method === 'terminal.create')
    ).toEqual([])
  })

  it.each([
    { name: 'rejected credentials', message: 'All configured authentication methods failed' },
    {
      name: 'sign-in message combined with another failure',
      message: 'SSH host needs you to sign in. Reconnect to sign in.\nPermission denied.'
    },
    {
      name: 'rejected pairing',
      message: 'Remote runtime pairing credentials expired.',
      code: 'unauthorized'
    }
  ])('does not auto-revive $name', async (failure) => {
    const { pane, signIn } = await mountAwaitingPane(tabId, failure)
    expect(pane.getRecoveryState?.().phase).toBe('offline')
    const callsAfterFailure = runtimeCall.mock.calls.length

    expect(signIn()).toBe(0)
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)

    expect(pane.isConnected()).toBe(false)
    expect(subscribedTerminalHandles()).toEqual([])
    expect(runtimeCall).toHaveBeenCalledTimes(callsAfterFailure)
  })

  it.each(['detach', 'destroy'] as const)('does not revive a pane after %s', async (teardown) => {
    const { pane, signIn } = await mountAwaitingPane(tabId, pendingErrors[0])
    expect(pane.getRecoveryState?.().phase).toBe('backoff')
    pane[teardown]?.()
    const callsAfterTeardown = runtimeCall.mock.calls.length

    expect(signIn()).toBe(0)
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)

    expect(subscribedTerminalHandles()).toEqual([])
    expect(runtimeCall).toHaveBeenCalledTimes(callsAfterTeardown)
  })
})
