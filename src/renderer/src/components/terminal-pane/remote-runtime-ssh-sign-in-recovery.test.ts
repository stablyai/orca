import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyTransport, PtyTransportRecoveryState } from './pty-transport-types'
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
  runtimeSubscribe,
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
    expect(pane.getRecoveryState?.()).toMatchObject({ phase: 'backoff', reason: 'ssh-sign-in' })
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
  const { reviveRemoteRuntimePtyRecoveriesForEnvironment } =
    await import('./remote-runtime-pty-recovery-state')
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
  it.each(
    pendingErrors.flatMap((failure) =>
      [false, true].map((late) => ({
        ...failure,
        late,
        timing: late ? 'after the recovery deadline' : 'before the recovery deadline'
      }))
    )
  )('waits for sign-in and then starts for $name $timing', async (failure) => {
    const { pane, onError, onPtySpawn, signIn, connected, connectSettled } =
      await mountNewPaneAwaitingSignIn(failure)
    expect(pane.getRecoveryState?.()).toMatchObject({
      phase: 'backoff',
      reason: 'ssh-sign-in'
    })
    expect(onError).not.toHaveBeenCalled()
    expect(connectSettled()).toBe(false)

    if (failure.late) {
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)
      expect(pane.getRecoveryState?.()).toMatchObject({
        phase: 'disconnected',
        reason: 'ssh-sign-in'
      })
    }

    expect(signIn()).toBe(1)
    await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
    const { streamId } = latestSubscribePayload()
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'subscribed', streamId }
    })
    emitSnapshot(streamId, 'fresh prompt$ ')

    expect(onPtySpawn).toHaveBeenCalledTimes(1)
    expect(onPtySpawn).toHaveBeenCalledWith('remote:env-1@@terminal-1')
    // The original spawn settles with the post-sign-in create, so its finalization still runs.
    await expect(connected).resolves.toMatchObject({ id: 'remote:env-1@@terminal-1' })
    expect(pane.isConnected()).toBe(true)
    expect(pane.getRecoveryState?.().reason).toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
  })

  it('starts after a sign-in that was cancelled and completed later', async () => {
    const failure = { message: pendingErrors[0].message }
    const pending = await mountNewPaneAwaitingSignIn(failure)
    failure.message = pendingErrors[2].message
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)
    expect(pending.pane.getRecoveryState?.()).toMatchObject({
      phase: 'disconnected',
      reason: 'ssh-sign-in'
    })

    expect(pending.signIn()).toBe(1)
    await vi.waitFor(() => expect(pending.onPtySpawn).toHaveBeenCalledTimes(1))
    expect(pending.onError).not.toHaveBeenCalled()
  })

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
    const { reviveRemoteRuntimePtyRecoveriesForEnvironment } =
      await import('./remote-runtime-pty-recovery-state')
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

  it('stops showing the sign-in wait once sign-in finishes, even while the create still retries', async () => {
    const { pane, lastPublishedState, signIn } = await mountNewPaneAwaitingSignIn(
      pendingErrors[0],
      () => {
        throw Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
          code: 'remote_runtime_unavailable'
        })
      }
    )
    expect(lastPublishedState()?.reason).toBe('ssh-sign-in')

    signIn()
    await vi.advanceTimersByTimeAsync(0)

    expect(pane.getRecoveryState?.().phase).not.toBe('idle')
    expect(lastPublishedState()?.reason).toBeUndefined()
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

  it('still reports rejected credentials instead of waiting', async () => {
    const { pane, onError, signIn, createCalls } = await mountNewPaneAwaitingSignIn({
      message: 'All configured authentication methods failed'
    })
    expect(onError).toHaveBeenCalledWith('All configured authentication methods failed')
    expect(pane.getRecoveryState?.().reason).toBeUndefined()
    const createsAfterFailure = createCalls().length

    expect(signIn()).toBe(0)
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)
    expect(createCalls()).toHaveLength(createsAfterFailure)
  })
})
