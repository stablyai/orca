// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkerDockSnapshot } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { useWorkerDockColdSeed, useWorkerDockFeed } from './worker-dock-feed'

const rpc = vi.hoisted(() => ({
  event: (_value: unknown) => {},
  resolve: (_value: unknown) => {},
  reject: (_error: unknown) => {},
  calls: 0
}))
vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: async (
    _target: unknown,
    _method: unknown,
    _params: unknown,
    observer: { onEvent: (value: unknown) => void }
  ) => {
    rpc.event = observer.onEvent
    return { unsubscribe: () => {} }
  }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: () =>
    new Promise((resolve, reject) => {
      rpc.calls++
      rpc.resolve = resolve
      rpc.reject = reject
    })
}))
vi.mock('@/lib/window-activity/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('filters settled workers from the roster returned by an older host', async () => {
  const presence = { revision: 'feed-legacy:1', open: true }
  const hook = renderHook(() =>
    useWorkerDockFeed({ kind: 'local' }, '33333333-3333-4333-8333-333333333333', true, presence)
  )
  const states = ['running', 'needs-you', 'failed', 'unexpected', 'saving'] as const
  const identities = states.map((state) => ({
    id: state,
    dispatchId: state,
    state,
    changedAt: null,
    ownerActionsAvailable: true,
    settlement: null,
    hasModel: false
  }))
  await act(async () => {
    rpc.event({ revision: 1, expired: false, identities, rows: [], anchor: null })
  })
  expect(hook.result.current.snapshot?.identities.map((row) => row.state)).toEqual([
    'running',
    'needs-you'
  ])
})

it("keeps an older host's recent failures, newest four, and drops the stale ones", async () => {
  const presence = { revision: 'feed-legacy-failures:1', open: true }
  const hook = renderHook(() =>
    useWorkerDockFeed({ kind: 'local' }, '44444444-4444-4444-8444-444444444444', true, presence)
  )
  const now = Date.parse('2026-11-23T12:00:00Z')
  vi.useFakeTimers({ now, toFake: ['Date'] })
  const failure = (id: string, minutesAgo: number) => ({
    id,
    dispatchId: id,
    state: 'failed' as const,
    changedAt: now - minutesAgo * 60_000,
    ownerActionsAvailable: true,
    settlement: `settled:${id}`,
    hasModel: false
  })
  const identities = [
    failure('old', 5 * 60),
    failure('f1', 1),
    failure('f2', 2),
    failure('f3', 3),
    failure('f4', 4),
    failure('f5', 5)
  ]
  await act(async () => {
    rpc.event({ revision: 1, expired: false, identities, rows: [], anchor: null })
  })
  expect(hook.result.current.snapshot?.identities.map((row) => row.id)).toEqual([
    'f1',
    'f2',
    'f3',
    'f4'
  ])
})

it('keeps a newer streamed settlement when an older detail window arrives later', async () => {
  const target = { kind: 'local' } as const
  const presence = { revision: 'feed-test:1', open: true }
  const hook = renderHook(() =>
    useWorkerDockFeed(target, '11111111-1111-4111-8111-111111111111', true, presence)
  )
  const snapshot = (revision: number): WorkerDockSnapshot => ({
    revision,
    expired: false,
    identities: [],
    rows: [],
    anchor: null
  })
  await act(async () => {
    rpc.event(snapshot(2))
  })
  let loading: Promise<void> | undefined
  act(() => {
    loading = hook.result.current.loadWindow?.('old-worker')
  })
  await act(async () => {
    rpc.event(snapshot(3))
  })
  await act(async () => {
    rpc.resolve(snapshot(2))
    await loading
  })
  expect(hook.result.current.snapshot?.revision).toBe(3)
  expect(hook.result.current.available).toBe(true)
})

it('seeds a source again after a failed cold read, and never after one that succeeded', async () => {
  const target = { kind: 'local' } as const
  const session = '22222222-2222-4222-8222-222222222222'
  const mount = () => renderHook(() => useWorkerDockColdSeed(target, session, true))
  rpc.calls = 0
  let hook = mount()
  expect(rpc.calls).toBe(1)
  await act(async () => {
    rpc.reject(new Error('runtime restarting'))
  })
  hook.unmount()
  hook = mount()
  expect(rpc.calls).toBe(2)
  await act(async () => {
    rpc.resolve({})
  })
  hook.unmount()
  mount()
  expect(rpc.calls).toBe(2)
})

it('counts a feed loss that recovers before React renders, read live', async () => {
  const presence = { revision: 'feed-losses:1', open: true }
  const hook = renderHook(() =>
    useWorkerDockFeed({ kind: 'local' }, '55555555-5555-4555-8555-555555555555', true, presence)
  )
  const snapshot = { revision: 1, expired: false, identities: [], rows: [], anchor: null }
  await act(async () => {
    rpc.event(snapshot)
  })
  const { readLosses } = hook.result.current
  expect(readLosses()).toBe(0)
  // A loss and its recovery published back to back, with no render between them.
  rpc.event({ ...snapshot, revision: 2, unavailable: true })
  rpc.event({ ...snapshot, revision: 3 })
  expect(readLosses()).toBe(1)
  await act(async () => {})
  expect(hook.result.current.available).toBe(true)
  expect(hook.result.current.readLosses()).toBe(1)
})
