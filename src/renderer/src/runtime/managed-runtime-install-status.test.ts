import { afterEach, expect, it, vi } from 'vitest'
import type { ManagedRuntimeInstallState } from '../../../shared/managed-runtime-install'
import type { RuntimeRpcSubscriptionHandlers } from './runtime-rpc-subscribe'
import {
  observeManagedRuntimeInstall,
  readManagedRuntimeInstall,
  type ManagedRuntimeInstallSubject
} from './managed-runtime-install-status'

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('./runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: subscribe }))

const state = (revision: number): ManagedRuntimeInstallState => ({
  agent: 'fake',
  revision,
  available: true,
  version: '1.3.0',
  installedVersion: null,
  installedCurrent: false,
  source: null,
  operation: null
})

afterEach(() => {
  vi.useRealTimers()
})

it('orders frames by revision and drops a superseded stream after the host restarts', async () => {
  vi.useFakeTimers()
  const streams: RuntimeRpcSubscriptionHandlers[] = []
  subscribe.mockImplementation(async (_target, _method, _params, handlers) => {
    streams.push(handlers)
    return { unsubscribe: vi.fn() }
  })
  const subject: ManagedRuntimeInstallSubject = {
    target: { kind: 'local' },
    runtimeId: null,
    agent: 'fake'
  }
  const release = observeManagedRuntimeInstall(subject)
  expect(subscribe).toHaveBeenCalledWith(
    { kind: 'local' },
    'managedRuntime.subscribe',
    { agent: 'fake' },
    expect.anything()
  )
  streams[0].onEvent(state(4))
  streams[0].onEvent(state(5))
  streams[0].onEvent(state(3))
  expect(readManagedRuntimeInstall(subject)).toEqual({ kind: 'known', state: state(5) })

  // The host restarts: its revisions start again, and the old stream's late frame is dropped.
  streams[0].onClose()
  await vi.advanceTimersByTimeAsync(1000)
  streams[1].onEvent(state(0))
  streams[0].onEvent(state(9))
  expect(readManagedRuntimeInstall(subject)).toEqual({ kind: 'known', state: state(0) })
  release()
})
