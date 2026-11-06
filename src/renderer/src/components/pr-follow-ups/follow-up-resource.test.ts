// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FollowUpSnapshot } from '../../../../shared/pr-follow-ups/contracts'
import {
  usePrFollowUpFixing,
  usePrFollowUpsAvailable,
  usePrFollowUpWorkspace
} from './follow-up-resource'

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../../runtime/runtime-rpc-client', () => ({ callRuntimeRpc: call }))
afterEach(cleanup)

it('streams nothing while hidden and preserves workspace and availability subscriptions across unrelated updates', async () => {
  let next: FollowUpSnapshot = { available: false, workspaces: {} }
  call.mockImplementation(async () => structuredClone(next))
  let changed: (response: { ok: true; result: { type: string } }) => void = () => undefined
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(async (_request, onEvent) => {
    changed = onEvent
    return { unsubscribe }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { runtime: { subscribe } } })
  const hidden = renderHook(() => usePrFollowUpsAvailable())
  await act(async () => undefined)
  expect(hidden.result.current).toBe(false)
  expect(subscribe).not.toHaveBeenCalled()
  hidden.unmount()

  next = {
    available: true,
    workspaces: {
      w1: {
        prKey: 'pr1',
        fixing: false,
        view: { state: 'armed', stopped: false, used: 0, limit: 3 }
      },
      w2: {
        prKey: 'pr2',
        fixing: false,
        view: { state: 'armed', stopped: false, used: 0, limit: 3 }
      }
    }
  }
  let badgeRenders = 0
  let rowRenders = 0
  let availabilityRenders = 0
  const badge = renderHook(() => {
    badgeRenders += 1
    return usePrFollowUpFixing('w1')
  })
  const row = renderHook(() => {
    rowRenders += 1
    return usePrFollowUpWorkspace('w1')
  })
  const settings = renderHook(() => {
    availabilityRenders += 1
    return usePrFollowUpsAvailable()
  })
  await act(async () => undefined)
  expect(subscribe).toHaveBeenCalledWith(
    { method: 'runtime.clientEvents.subscribe', params: { prFollowUpsOnly: true } },
    expect.any(Function)
  )
  const before = { badgeRenders, rowRenders, availabilityRenders }
  next.workspaces.w2!.fixing = true
  await act(async () => changed({ ok: true, result: { type: 'prFollowUpsChanged' } }))
  expect({ badgeRenders, rowRenders, availabilityRenders }).toEqual(before)
  next.workspaces.w1!.fixing = true
  await act(async () => changed({ ok: true, result: { type: 'prFollowUpsChanged' } }))
  expect(badge.result.current).toBe(true)
  expect(badgeRenders).toBeGreaterThan(before.badgeRenders)
  expect(rowRenders).toBeGreaterThan(before.rowRenders)
  expect(availabilityRenders).toBe(before.availabilityRenders)
  badge.unmount()
  row.unmount()
  settings.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
