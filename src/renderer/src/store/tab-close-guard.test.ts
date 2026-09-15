import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({
  getStateMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

import { guardTabClose, isUnifiedTabPinned, resolveTabLabel } from './tab-close-guard'
import type { AppState } from './types'

function makeState(overrides: Partial<AppState>): AppState {
  return {
    settings: { confirmClosePinnedTab: true, confirmCloseAnyTab: false },
    unifiedTabsByWorktree: {},
    requestPinnedTabCloseConfirm: vi.fn(),
    cancelPinnedTabCloseRequest: vi.fn(),
    ...overrides
  } as unknown as AppState
}

describe('guardTabClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('closes immediately for a non-pinned tab when neither confirm setting applies', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(makeState({ requestPinnedTabCloseConfirm }))

    guardTabClose({ isPinned: false, tabLabel: 'Docs', onClose })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
  })

  it('requests a pinned confirmation for a pinned tab when the setting is on', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        settings: {
          confirmClosePinnedTab: true,
          confirmCloseAnyTab: false
        } as AppState['settings'],
        requestPinnedTabCloseConfirm
      })
    )

    guardTabClose({ isPinned: true, tabLabel: 'Docs', onClose })

    expect(onClose).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith({
      tabLabel: 'Docs',
      variant: 'pinned',
      onConfirm: onClose
    })
  })

  it('passes cancel callbacks to confirmation requests', () => {
    const onClose = vi.fn()
    const onCancel = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        settings: {
          confirmClosePinnedTab: true,
          confirmCloseAnyTab: false
        } as AppState['settings'],
        requestPinnedTabCloseConfirm
      })
    )

    guardTabClose({ isPinned: true, tabLabel: 'Docs', onClose, onCancel })

    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith({
      tabLabel: 'Docs',
      variant: 'pinned',
      onConfirm: onClose,
      onCancel
    })
  })

  it('returns a cancellation for the exact queued confirmation', () => {
    const cancelPinnedTabCloseRequest = vi.fn()
    getStateMock.mockReturnValue(makeState({ cancelPinnedTabCloseRequest }))

    const cancel = guardTabClose({ isPinned: true, tabLabel: 'Docs', onClose: vi.fn() })
    const request = getStateMock().requestPinnedTabCloseConfirm.mock.calls[0][0]
    cancel?.()

    expect(cancelPinnedTabCloseRequest).toHaveBeenCalledWith(request)
  })

  it('closes a pinned tab immediately when both settings are off', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        settings: {
          confirmClosePinnedTab: false,
          confirmCloseAnyTab: false
        } as AppState['settings'],
        requestPinnedTabCloseConfirm
      })
    )

    guardTabClose({ isPinned: true, tabLabel: 'Docs', onClose })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
  })

  it('defaults to confirming pinned tabs when settings are not loaded yet', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(makeState({ settings: null, requestPinnedTabCloseConfirm }))

    guardTabClose({ isPinned: true, tabLabel: 'Docs', onClose })

    expect(onClose).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm.mock.calls[0][0]).toMatchObject({ variant: 'pinned' })
  })

  it('requests an any-tab confirmation for a non-pinned tab when confirmCloseAnyTab is on and userInitiated', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        settings: { confirmClosePinnedTab: true, confirmCloseAnyTab: true } as AppState['settings'],
        requestPinnedTabCloseConfirm
      })
    )

    guardTabClose({ isPinned: false, tabLabel: 'Docs', userInitiated: true, onClose })

    expect(onClose).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith({
      tabLabel: 'Docs',
      variant: 'any',
      onConfirm: onClose
    })
  })

  it('does not open the any-tab dialog for a non-user-initiated close', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        settings: { confirmClosePinnedTab: true, confirmCloseAnyTab: true } as AppState['settings'],
        requestPinnedTabCloseConfirm
      })
    )

    // Why: lifecycle/CLI/remote closes omit userInitiated and must close immediately.
    guardTabClose({ isPinned: false, tabLabel: 'Docs', onClose })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
  })

  it('prefers the pinned variant when a pinned tab also matches confirmCloseAnyTab', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        settings: { confirmClosePinnedTab: true, confirmCloseAnyTab: true } as AppState['settings'],
        requestPinnedTabCloseConfirm
      })
    )

    guardTabClose({ isPinned: true, tabLabel: 'Docs', userInitiated: true, onClose })

    expect(requestPinnedTabCloseConfirm.mock.calls[0][0]).toMatchObject({ variant: 'pinned' })
  })

  it('confirms via the any-tab variant for a pinned tab when only confirmCloseAnyTab is on', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        settings: {
          confirmClosePinnedTab: false,
          confirmCloseAnyTab: true
        } as AppState['settings'],
        requestPinnedTabCloseConfirm
      })
    )

    guardTabClose({ isPinned: true, tabLabel: 'Docs', userInitiated: true, onClose })

    expect(onClose).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm.mock.calls[0][0]).toMatchObject({ variant: 'any' })
  })
})

describe('resolveTabLabel', () => {
  it('uses the same label priority as the tab strip', () => {
    const state = makeState({
      settings: {
        confirmClosePinnedTab: true,
        tabAutoGenerateTitle: true
      } as AppState['settings'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'a',
            entityId: 'ea',
            customLabel: ' Custom ',
            quickCommandLabel: 'Run tests',
            generatedLabel: 'Gen',
            label: 'Plain'
          },
          {
            id: 'b',
            entityId: 'eb',
            customLabel: '   ',
            quickCommandLabel: ' Run tests ',
            generatedLabel: 'Gen',
            label: 'Plain'
          },
          {
            id: 'c',
            entityId: 'ec',
            customLabel: null,
            quickCommandLabel: null,
            generatedLabel: ' Gen ',
            label: 'Plain'
          },
          {
            id: 'd',
            entityId: 'ed',
            customLabel: null,
            quickCommandLabel: null,
            generatedLabel: null,
            label: ' Plain '
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree']
    })

    expect(resolveTabLabel(state, 'wt-1', 'a')).toBe('Custom')
    expect(resolveTabLabel(state, 'wt-1', 'b')).toBe('Run tests')
    expect(resolveTabLabel(state, 'wt-1', 'ec')).toBe('Gen')
    expect(resolveTabLabel(state, 'wt-1', 'ed')).toBe('Plain')
  })

  it('falls back to the live label when generated tab titles are disabled', () => {
    const state = makeState({
      settings: {
        confirmClosePinnedTab: true,
        tabAutoGenerateTitle: false
      } as AppState['settings'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'a',
            entityId: 'ea',
            customLabel: null,
            quickCommandLabel: null,
            generatedLabel: 'Gen',
            label: 'Plain'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree']
    })

    expect(resolveTabLabel(state, 'wt-1', 'a')).toBe('Plain')
  })

  it('returns an empty string when the tab is not found', () => {
    expect(resolveTabLabel(makeState({}), 'wt-1', 'missing')).toBe('')
  })
})

describe('isUnifiedTabPinned', () => {
  const state = makeState({
    unifiedTabsByWorktree: {
      'wt-1': [
        { id: 'uni-1', entityId: 'ent-1', isPinned: true },
        { id: 'uni-2', entityId: 'ent-2', isPinned: false }
      ]
    } as unknown as AppState['unifiedTabsByWorktree']
  })

  it('matches a pinned tab by its unified id or entityId', () => {
    expect(isUnifiedTabPinned(state, 'wt-1', 'uni-1')).toBe(true)
    expect(isUnifiedTabPinned(state, 'wt-1', 'ent-1')).toBe(true)
  })

  it('returns false for unpinned or unknown tabs', () => {
    expect(isUnifiedTabPinned(state, 'wt-1', 'uni-2')).toBe(false)
    expect(isUnifiedTabPinned(state, 'wt-1', 'missing')).toBe(false)
    expect(isUnifiedTabPinned(state, 'wt-unknown', 'uni-1')).toBe(false)
  })
})
