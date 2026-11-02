import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({
  getStateMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

import { guardPinnedTabClose } from './pinned-tab-close-guard'

import type { AppState } from './types'

function makeState(overrides: Partial<AppState>): AppState {
  return {
    settings: { confirmClosePinnedTab: true },
    unifiedTabsByWorktree: {},
    requestPinnedTabCloseConfirm: vi.fn(),
    cancelPinnedTabCloseRequest: vi.fn(),
    ...overrides
  } as unknown as AppState
}

describe('guardPinnedTabClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a cancellation for the exact queued confirmation', () => {
    const cancelPinnedTabCloseRequest = vi.fn()
    getStateMock.mockReturnValue(makeState({ cancelPinnedTabCloseRequest }))

    const cancel = guardPinnedTabClose({ isPinned: true, tabLabel: 'Docs', onClose: vi.fn() })
    const request = getStateMock().requestPinnedTabCloseConfirm.mock.calls[0][0]
    cancel?.()

    expect(cancelPinnedTabCloseRequest).toHaveBeenCalledWith(request)
  })

  it('defaults to confirming when settings are not loaded yet', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(makeState({ settings: null, requestPinnedTabCloseConfirm }))

    guardPinnedTabClose({ isPinned: true, tabLabel: 'Docs', onClose })

    expect(onClose).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
  })
})
