import { expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { createAppStoreNotificationRouter } from './app-store-notification-router'

const numbers = new WeakMap<AppState, number>()
function stateOf(n: number): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listeners read states only through nOf.
  const state = {} as AppState
  numbers.set(state, n)
  return state
}
const nOf = (state: AppState): number | undefined => numbers.get(state)

function setup(skip: boolean) {
  let dispatch: ((state: AppState, previous: AppState) => void) | null = null
  let current = stateOf(0)
  const afterSkippedDispatch = vi.fn()
  const router = createAppStoreNotificationRouter(
    (listener) => {
      dispatch = listener
      return () => {}
    },
    () => current,
    { skipRootSelectorsOnChannelOnlyWrites: skip, afterSkippedDispatch }
  )
  const write = (n: number, channelOnly = false) => {
    const previous = current
    current = stateOf(n)
    router.classifyNextWrite(channelOnly)
    dispatch!(current, previous)
  }
  return { router, write, afterSkippedDispatch }
}

it('skips root selectors on channel-only writes while other subscribers hear every write', () => {
  const { router, write, afterSkippedDispatch } = setup(true)
  const selector = vi.fn()
  const observer = vi.fn()
  router.subscribeRootSelector(selector)
  router.subscribe(observer)

  write(1, true)
  expect(selector).toHaveBeenCalledTimes(0)
  expect(observer).toHaveBeenCalledTimes(1)
  expect(afterSkippedDispatch).toHaveBeenCalledTimes(1)

  write(2)
  expect(selector).toHaveBeenCalledTimes(1)
  expect(observer).toHaveBeenCalledTimes(2)
  expect(afterSkippedDispatch).toHaveBeenCalledTimes(1)
})

it('wakes every listener when skipping is off', () => {
  const { router, write, afterSkippedDispatch } = setup(false)
  const selector = vi.fn()
  router.subscribeRootSelector(selector)
  write(1, true)
  expect(selector).toHaveBeenCalledTimes(1)
  expect(afterSkippedDispatch).toHaveBeenCalledTimes(0)
})

it('hands later listeners the state a nested write produced', () => {
  const { router, write } = setup(false)
  const seen: (number | undefined)[][] = []
  router.subscribe((state) => {
    if (nOf(state) === 1) {
      write(2)
    }
  })
  router.subscribe((state, previous) => {
    seen.push([nOf(state), nOf(previous)])
  })
  write(1)
  expect(seen).toEqual([
    [2, 1],
    [2, 0]
  ])
})
