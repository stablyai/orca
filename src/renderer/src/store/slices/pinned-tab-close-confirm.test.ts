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
})
