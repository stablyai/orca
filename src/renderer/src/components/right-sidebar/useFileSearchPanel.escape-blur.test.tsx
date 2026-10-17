// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileSearchPanel } from './useFileSearchPanel'

const mocks = vi.hoisted(() => ({
  clearFileSearch: vi.fn(),
  updateFileSearchState: vi.fn(),
  consumeFileSearchSeedRequest: vi.fn(),
  toggleFileSearchCollapsedFile: vi.fn(),
  openFile: vi.fn(),
  setPendingEditorReveal: vi.fn(),
  executeSearch: vi.fn(),
  cancelPendingSearch: vi.fn(),
  query: ''
}))

const WORKTREE_ID = 'repo::/repo'

function buildState(): Record<string, unknown> {
  return {
    activeWorktreeId: WORKTREE_ID,
    openFile: mocks.openFile,
    setPendingEditorReveal: mocks.setPendingEditorReveal,
    fileSearchStateByWorktree: {
      [WORKTREE_ID]: { query: mocks.query }
    },
    updateFileSearchState: mocks.updateFileSearchState,
    consumeFileSearchSeedRequest: mocks.consumeFileSearchSeedRequest,
    toggleFileSearchCollapsedFile: mocks.toggleFileSearchCollapsedFile,
    clearFileSearch: mocks.clearFileSearch
  }
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(buildState()),
    { getState: () => buildState() }
  )
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ id: WORKTREE_ID, path: '/repo' })
}))

vi.mock('./useFileSearchRunner', () => ({
  useFileSearchRunner: () => ({
    executeSearch: mocks.executeSearch,
    cancelPendingSearch: mocks.cancelPendingSearch
  })
}))

// Escape must always release the query field: with text it also clears, empty it
// still backs out. Asserted against real focus, not a spy, so a handler that
// "handles" Escape without blurring still fails.
function pressEscapeOnFocusedInput(query: string): {
  activeAfter: Element | null
  input: HTMLInputElement
} {
  mocks.query = query
  const { result } = renderHook(() => useFileSearchPanel('search'))

  const input = document.createElement('input')
  document.body.appendChild(input)
  ;(result.current.queryRowProps.inputRef as { current: HTMLInputElement | null }).current = input
  input.focus()
  expect(document.activeElement).toBe(input)

  act(() => {
    result.current.queryRowProps.onKeyDown?.({
      key: 'Escape',
      nativeEvent: { isComposing: false }
    } as unknown as React.KeyboardEvent)
  })

  return { activeAfter: document.activeElement, input }
}

describe('file search panel Escape handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('releases focus and clears when the query is non-empty', () => {
    const { activeAfter, input } = pressEscapeOnFocusedInput('useCallback')

    expect(activeAfter).not.toBe(input)
    expect(mocks.clearFileSearch).toHaveBeenCalledWith(WORKTREE_ID)
  })

  it('releases focus when the query is empty without clearing', () => {
    const { activeAfter, input } = pressEscapeOnFocusedInput('')

    expect(activeAfter).not.toBe(input)
    expect(mocks.clearFileSearch).not.toHaveBeenCalled()
  })

  it('leaves focus alone for other keys', () => {
    mocks.query = 'useCallback'
    const { result } = renderHook(() => useFileSearchPanel('search'))

    const input = document.createElement('input')
    document.body.appendChild(input)
    ;(result.current.queryRowProps.inputRef as { current: HTMLInputElement | null }).current = input
    input.focus()

    act(() => {
      result.current.queryRowProps.onKeyDown?.({
        key: 'Enter',
        nativeEvent: { isComposing: false }
      } as unknown as React.KeyboardEvent)
    })

    expect(document.activeElement).toBe(input)
  })
})
