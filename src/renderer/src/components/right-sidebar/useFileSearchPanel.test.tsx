// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileSearchPanel } from './useFileSearchPanel'
import { SearchQueryRow } from './SearchQueryRow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  executeSearch: vi.fn(),
  cancelPendingSearch: vi.fn(),
  clearFileSearch: vi.fn()
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
  return { useAppStore }
})

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ path: '/repo' })
}))

vi.mock('./useFileSearchRunner', () => ({
  useFileSearchRunner: () => ({
    executeSearch: mocks.executeSearch,
    cancelPendingSearch: mocks.cancelPendingSearch
  })
}))

function Harness(): React.JSX.Element {
  const model = useFileSearchPanel('search')
  return <SearchQueryRow {...model.queryRowProps} />
}

let container: HTMLDivElement
let root: Root

function renderPanel(query: string): void {
  mocks.state = {
    activeWorktreeId: 'wt-1',
    openFile: vi.fn(),
    setPendingEditorReveal: vi.fn(),
    fileSearchStateByWorktree: { 'wt-1': { query } },
    updateFileSearchState: vi.fn(),
    consumeFileSearchSeedRequest: vi.fn(),
    toggleFileSearchCollapsedFile: vi.fn(),
    clearFileSearch: mocks.clearFileSearch
  }
  act(() => {
    root.render(<Harness />)
  })
}

function input(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>('input')
  if (!element) {
    throw new Error('query input not rendered')
  }
  return element
}

function pressEscape(isComposing = false): void {
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', isComposing, bubbles: true, cancelable: true })
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

describe('useFileSearchPanel Escape handling', () => {
  it('clears the search and blurs the input when a query is present', () => {
    renderPanel('owner')
    act(() => {
      input().focus()
    })

    pressEscape()

    expect(mocks.clearFileSearch).toHaveBeenCalledWith('wt-1')
    expect(document.activeElement).not.toBe(input())
  })

  it('blurs the input even when the query is empty', () => {
    renderPanel('')
    act(() => {
      input().focus()
    })

    pressEscape()

    expect(mocks.clearFileSearch).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(input())
  })

  it('keeps focus and query while IME composition is active', () => {
    renderPanel('가나')
    act(() => {
      input().focus()
    })

    pressEscape(true)

    expect(mocks.clearFileSearch).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input())
  })
})
