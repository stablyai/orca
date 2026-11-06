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
  let installed: () => void = () => undefined
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(async () => {
    return { unsubscribe }
  })
  const releaseNotices = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtime: {
        subscribe,
        onPrFollowUpsChanged: (listener: () => void) => {
          installed = listener
          return releaseNotices
        }
      }
    }
  })
  const hidden = renderHook(() => usePrFollowUpsAvailable())
  await act(async () => undefined)
  expect(hidden.result.current).toBe(false)
  expect(subscribe).not.toHaveBeenCalled()

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
  await act(async () => installed())
  expect(hidden.result.current).toBe(true)
  expect(subscribe).not.toHaveBeenCalled()
  hidden.unmount()
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
  const before = { badgeRenders, rowRenders, availabilityRenders }
  next.workspaces.w2!.fixing = true
  await act(async () => installed())
  expect({ badgeRenders, rowRenders, availabilityRenders }).toEqual(before)
  next.workspaces.w1!.fixing = true
  await act(async () => installed())
  expect(badge.result.current).toBe(true)
  expect(badgeRenders).toBeGreaterThan(before.badgeRenders)
  expect(rowRenders).toBeGreaterThan(before.rowRenders)
  expect(availabilityRenders).toBe(before.availabilityRenders)
  badge.unmount()
  row.unmount()
  settings.unmount()
  expect(unsubscribe).not.toHaveBeenCalled()
  expect(releaseNotices).toHaveBeenCalledTimes(2)
})
