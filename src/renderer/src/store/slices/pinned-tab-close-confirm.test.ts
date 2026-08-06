import { create } from 'zustand'
import { describe, expect, it, vi } from 'vitest'
import { createPinnedTabCloseConfirmSlice } from './pinned-tab-close-confirm'
import type { AppState } from '../types'

function makeStore() {
  return create<
    Pick<
      AppState,
      | 'pinnedTabCloseConfirm'
      | 'requestPinnedTabCloseConfirm'
      | 'confirmPinnedTabClose'
      | 'dismissPinnedTabClose'
    >
  >()((...args) =>
    createPinnedTabCloseConfirmSlice(
      ...(args as Parameters<typeof createPinnedTabCloseConfirmSlice>)
    )
  )
}

describe('createPinnedTabCloseConfirmSlice', () => {
  it('starts with no pending request', () => {
    expect(makeStore().getState().pinnedTabCloseConfirm).toBeNull()
  })

  it('stores the pending request when one is requested', () => {
    const store = makeStore()
    const onConfirm = vi.fn()

    store.getState().requestPinnedTabCloseConfirm({ tabLabel: 'Docs', onConfirm })

    expect(store.getState().pinnedTabCloseConfirm).toEqual({ tabLabel: 'Docs', onConfirm })
  })

  it('runs onConfirm and clears the request when confirmed', () => {
    const store = makeStore()
    const onConfirm = vi.fn()
    store.getState().requestPinnedTabCloseConfirm({ tabLabel: 'Docs', onConfirm })

    store.getState().confirmPinnedTabClose()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(store.getState().pinnedTabCloseConfirm).toBeNull()
  })

  it('clears the request before running onConfirm so re-entrant closes do not loop', () => {
    const store = makeStore()
    const onConfirm = vi.fn(() => {
      // Why: a close path may synchronously inspect the pending request; it must
      // already be cleared by the time onConfirm runs.
      expect(store.getState().pinnedTabCloseConfirm).toBeNull()
    })
    store.getState().requestPinnedTabCloseConfirm({ tabLabel: 'Docs', onConfirm })

    store.getState().confirmPinnedTabClose()

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('does nothing when confirming with no pending request', () => {
    const store = makeStore()
    expect(() => store.getState().confirmPinnedTabClose()).not.toThrow()
    expect(store.getState().pinnedTabCloseConfirm).toBeNull()
  })

  it('dismisses without running onConfirm', () => {
    const store = makeStore()
    const onConfirm = vi.fn()
    store.getState().requestPinnedTabCloseConfirm({ tabLabel: 'Docs', onConfirm })

    store.getState().dismissPinnedTabClose()

    expect(onConfirm).not.toHaveBeenCalled()
    expect(store.getState().pinnedTabCloseConfirm).toBeNull()
  })

  it('runs onCancel and clears the request when dismissed', () => {
    const store = makeStore()
    const onCancel = vi.fn()
    store.getState().requestPinnedTabCloseConfirm({
      tabLabel: 'Docs',
      onConfirm: vi.fn(),
      onCancel
    })

    store.getState().dismissPinnedTabClose()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(store.getState().pinnedTabCloseConfirm).toBeNull()
  })

  it('queues concurrent requests and advances them in request order', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = makeStore()
    const firstConfirm = vi.fn()
    const secondConfirm = vi.fn()
    store.getState().requestPinnedTabCloseConfirm({
      tabLabel: 'First terminal',
      onConfirm: firstConfirm
    })
    store.getState().requestPinnedTabCloseConfirm({
      tabLabel: 'Second terminal',
      onConfirm: secondConfirm
    })

    expect(store.getState().pinnedTabCloseConfirm?.tabLabel).toBe('First terminal')
    store.getState().confirmPinnedTabClose()
    expect(firstConfirm).toHaveBeenCalledTimes(1)
    expect(secondConfirm).not.toHaveBeenCalled()
    expect(store.getState().pinnedTabCloseConfirm?.tabLabel).toBe('Second terminal')

    now.mockReturnValue(1_351)
    store.getState().confirmPinnedTabClose()
    expect(secondConfirm).toHaveBeenCalledTimes(1)
    expect(store.getState().pinnedTabCloseConfirm).toBeNull()
  })

  it('advances the queue when an earlier request is dismissed', () => {
    const store = makeStore()
    const firstCancel = vi.fn()
    store.getState().requestPinnedTabCloseConfirm({
      tabLabel: 'First terminal',
      onConfirm: vi.fn(),
      onCancel: firstCancel
    })
    store.getState().requestPinnedTabCloseConfirm({
      tabLabel: 'Second terminal',
      onConfirm: vi.fn()
    })

    store.getState().dismissPinnedTabClose()

    expect(firstCancel).toHaveBeenCalledTimes(1)
    expect(store.getState().pinnedTabCloseConfirm?.tabLabel).toBe('Second terminal')
  })

  it('ignores a rapid second action on the newly advanced request', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = makeStore()
    const secondConfirm = vi.fn()
    store.getState().requestPinnedTabCloseConfirm({ tabLabel: 'First', onConfirm: vi.fn() })
    store.getState().requestPinnedTabCloseConfirm({
      tabLabel: 'Second',
      onConfirm: secondConfirm
    })

    store.getState().confirmPinnedTabClose()
    store.getState().confirmPinnedTabClose()

    expect(secondConfirm).not.toHaveBeenCalled()
    expect(store.getState().pinnedTabCloseConfirm?.tabLabel).toBe('Second')
  })
})
