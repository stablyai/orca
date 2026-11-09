import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../../../shared/terminal/stream/terminal-stream-protocol'
import type { PtyTransport } from '../pty-transport-types'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => {
      throw new Error('Unexpected ownership read')
    }
  }
}))
let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-1'
const fixture = createRemoteRuntimeTransportMocks({
  getCallbacks: () => callbacks,
  setCallbacks: (next) => {
    callbacks = next
  },
  getResolvedPaneHandle: () => resolvedHandle,
  setResolvedPaneHandle: (next) => {
    resolvedHandle = next
  }
})
const transports: PtyTransport[] = []
function publish(retired = false, pairingRevision = 1) {
  const snapshot: RuntimeHostStatusSnapshot = {
    environmentId: 'env-1',
    pairingRevision,
    sequence: pairingRevision,
    checkedAt: 1,
    status: null,
    transport: retired ? 'disconnected' : 'ready',
    verification: retired ? 'blocked' : 'verified',
    ...(retired ? { retired: true } : {})
  }
  fixture.publishHostSnapshot(snapshot)
}
async function createTransport() {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  transports.push(transport)
  return transport
}
function pendingReply() {
  let reject: (error: Error) => void = () => {}
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise((settle, refuse) => {
    reject = refuse
    resolve = settle
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  fixture.resetRemoteRuntimeTransport()
  fixture.subscriptionSendBinary.mockImplementation((bytes) => {
    const frame = decodeTerminalStreamFrame(bytes)
    if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
      return
    }
    const payload = decodeTerminalStreamJson<{ streamId: number }>(frame.payload)!
    queueMicrotask(() => {
      callbacks?.onResponse({
        ok: true,
        result: { type: 'subscribed', streamId: payload.streamId }
      })
      fixture.emitSnapshot(payload.streamId, 'retained prompt$ ')
    })
  })
})
afterEach(() => {
  for (const transport of transports.splice(0)) {
    transport.destroy?.()
  }
  vi.useRealTimers()
})

it.each(['success', 'refusal'] as const)(
  'retires an awaited recovery iteration and fences its late %s before a verified legacy host revives it',
  async (settlement) => {
    publish()
    const transport = await createTransport()
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    await transport.connect({ url: '', callbacks: { onExit, onDisconnect } })
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    const retainedId = transport.getPtyId()
    const request = pendingReply()
    const dispatch = fixture.runtimeCall.getMockImplementation()!
    fixture.runtimeCall.mockImplementation((args) =>
      args.method === 'session.tabs.activate' ? request.promise : dispatch(args)
    )
    callbacks?.onClose?.()
    await vi.waitFor(() =>
      expect(
        fixture.runtimeCall.mock.calls.some(([args]) => args.method === 'session.tabs.activate')
      ).toBe(true)
    )

    publish(true)
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    expect(transport.getPtyId()).toBe(retainedId)
    expect(onExit).not.toHaveBeenCalled()
    expect(onDisconnect).not.toHaveBeenCalled()
    const callsAtStop = fixture.runtimeCall.mock.calls.length
    vi.useFakeTimers()
    request.resolve(
      settlement === 'success'
        ? await dispatch({ method: 'session.tabs.activate', params: { tabId: 'tab-1' } })
        : { ok: false, error: { code: 'runtime_manually_disconnected', message: 'Stopped' } }
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const { retryAllRemoteRuntimePtyRecoveriesNow } =
      await import('./recovery/remote-runtime-pty-recovery-state')
    retryAllRemoteRuntimePtyRecoveriesNow()
    expect(transport.retryRecovery?.()).toBe(false)
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    expect(fixture.runtimeCall.mock.calls.length).toBe(callsAtStop)

    vi.useRealTimers()
    fixture.runtimeCall.mockImplementation(dispatch)
    publish(false, 2)
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    expect(transport.getPtyId()).toBe(retainedId)
    callbacks?.onClose?.()
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
  }
)

it('terminates a current manual-disconnect refusal inside the production activate/list poll', async () => {
  const transport = await createTransport()
  await transport.connect({ url: '', callbacks: {} })
  await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
  const dispatch = fixture.runtimeCall.getMockImplementation()!
  fixture.runtimeCall.mockResolvedValue({
    ok: false,
    error: { code: 'runtime_manually_disconnected', message: 'Stopped' }
  })
  fixture.runtimeCall.mockClear()
  callbacks?.onClose?.()
  await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('disconnected'))
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fixture.runtimeCall.mock.calls.map(([args]) => args.method)).toEqual([
    'session.tabs.activate'
  ])
  vi.useRealTimers()
  fixture.runtimeCall.mockImplementation(dispatch)
  publish()
  await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
})

it.each(['connect', 'attach'] as const)(
  'observes an already-retired host before first %s and replays only after current contact',
  async (entry) => {
    publish(true)
    const transport = await createTransport()
    if (entry === 'connect') {
      await transport.connect({ url: '', callbacks: {} })
    } else {
      transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: {} })
    }
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    expect(fixture.runtimeCall).not.toHaveBeenCalled()
    publish(false, 2)
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
  }
)

it.each(['success', 'rejection'] as const)(
  'fences a pending first-create %s through Stop and reconciles on current contact',
  async (settlement) => {
    const transport = await createTransport()
    const reply = pendingReply()
    const dispatch = fixture.runtimeCall.getMockImplementation()!
    fixture.runtimeCall.mockImplementation((args) =>
      args.method === 'terminal.create' ? reply.promise : dispatch(args)
    )
    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() =>
      expect(
        fixture.runtimeCall.mock.calls.some(([args]) => args.method === 'terminal.create')
      ).toBe(true)
    )
    publish(true)
    const stoppedEpoch = transport.getRecoveryState?.().epoch
    if (settlement === 'rejection') {
      reply.reject(new Error('Remote Orca runtime connection closed.'))
    } else {
      reply.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
    }
    await connect
    expect(transport.getRecoveryState?.().epoch).toBe(stoppedEpoch)
    const { retryAllRemoteRuntimePtyRecoveriesNow } =
      await import('./recovery/remote-runtime-pty-recovery-state')
    expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(0)
    expect(transport.getPtyId()).toBeNull()
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    fixture.runtimeCall.mockImplementation((args) =>
      args.method === 'status.get'
        ? { ok: true, result: { capabilities: [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] } }
        : dispatch(args)
    )
    publish(false, 2)
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    const creates = fixture.runtimeCall.mock.calls.filter(
      ([args]) => args.method === 'terminal.create'
    )
    expect(creates).toHaveLength(2)
    expect(creates[1][0].params.reconcileExisting).toBe(true)
    expect(creates[1][0].params.clientMutationId).toBe(creates[0][0].params.clientMutationId)
  }
)
