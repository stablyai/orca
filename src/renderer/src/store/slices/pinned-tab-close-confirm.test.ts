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
      | 'cancelPinnedTabCloseRequest'
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
  it('clears the request before running onConfirm so re-entrant closes do not loop', () => {
    const store = makeStore()
    const onConfirm = vi.fn(() => {
      // Clear pending before onConfirm; close paths can synchronously inspect/reenter it.
      expect(store.getState().pinnedTabCloseConfirm).toBeNull()
    })
    store.getState().requestPinnedTabCloseConfirm({ tabLabel: 'Docs', onConfirm })

    store.getState().confirmPinnedTabClose()

    expect(onConfirm).toHaveBeenCalledTimes(1)
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
