// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkerDockSnapshot } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { useWorkerDockFeed } from './worker-dock-feed'

const rpc = vi.hoisted(() => ({ event: (_value: unknown) => {}, resolve: (_value: unknown) => {} }))
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
    new Promise((resolve) => {
      rpc.resolve = resolve
    })
}))
vi.mock('@/lib/window-activity/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))
afterEach(cleanup)

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
    results: [],
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
