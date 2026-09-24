// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SearchAddon } from '@xterm/addon-search'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalSearch from './TerminalSearch'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

type ResultsEvent = { resultIndex: number; resultCount: number }

function createSearchAddon() {
  let listener: ((payload: ResultsEvent) => void) | null = null
  const dispose = vi.fn(() => {
    listener = null
  })
  const stub = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: (handler: (payload: ResultsEvent) => void) => {
      listener = handler
      return { dispose }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The stub implements every addon member used by TerminalSearch.
  const addon = stub as unknown as SearchAddon
  return {
    addon,
    dispose,
    emit: (payload: ResultsEvent) => act(() => listener?.(payload))
  }
}

function renderSearch(searchAddon: SearchAddon, query = ''): ReturnType<typeof render> {
  const view = render(
    <TerminalSearch
      isOpen
      onClose={vi.fn()}
      searchAddon={searchAddon}
      searchStateRef={{ current: { query: '', caseSensitive: false, regex: false } }}
    />
  )
  if (query) {
    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: query } })
  }
  return view
}

describe('TerminalSearch match-count indicator', () => {
  it('renders 0/0 for an empty query', () => {
    const { addon } = createSearchAddon()
    expect(renderSearch(addon).getByText('0/0')).toBeTruthy()
  })

  it('renders current/total after a results event and updates on navigation', () => {
    const stub = createSearchAddon()
    const view = renderSearch(stub.addon, 'foo')
    stub.emit({ resultIndex: 2, resultCount: 12 })
    expect(view.getByText('3/12')).toBeTruthy()
    stub.emit({ resultIndex: 3, resultCount: 12 })
    expect(view.getByText('4/12')).toBeTruthy()
  })

  it('renders No results for a non-empty query with zero matches', () => {
    const stub = createSearchAddon()
    const view = renderSearch(stub.addon, 'foo')
    stub.emit({ resultIndex: -1, resultCount: 0 })
    expect(view.getByText('No results')).toBeTruthy()
  })

  it('renders count+ when the highlight threshold is exceeded', () => {
    const stub = createSearchAddon()
    const view = renderSearch(stub.addon, 'foo')
    stub.emit({ resultIndex: -1, resultCount: 1000 })
    expect(view.getByText('1000+')).toBeTruthy()
  })

  it('disposes the results subscription on unmount', () => {
    const stub = createSearchAddon()
    renderSearch(stub.addon, 'foo').unmount()
    expect(stub.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('TerminalSearch cleanup', () => {
  it('clears the current addon and count when the query is erased', async () => {
    const stub = createSearchAddon()
    const { addon } = stub
    const view = renderSearch(addon, 'needle')
    stub.emit({ resultIndex: 1, resultCount: 3 })
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())
    vi.mocked(addon.clearDecorations).mockClear()
    vi.mocked(addon.findNext).mockClear()

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: '' } })

    await waitFor(() => expect(addon.clearDecorations).toHaveBeenCalledTimes(1))
    expect(addon.findNext).toHaveBeenCalledWith('')
    expect(view.getByText('0/0')).toBeTruthy()
  })

  it('clears and unsubscribes the previous addon when search moves to another pane', async () => {
    const previous = createSearchAddon()
    const next = createSearchAddon()
    const view = renderSearch(previous.addon, 'needle')
    previous.emit({ resultIndex: 1, resultCount: 3 })
    await waitFor(() => expect(previous.addon.findNext).toHaveBeenCalled())
    vi.mocked(previous.addon.clearDecorations).mockClear()
    vi.mocked(previous.addon.findNext).mockClear()

    view.rerender(
      <TerminalSearch
        isOpen
        onClose={vi.fn()}
        searchAddon={next.addon}
        searchStateRef={{ current: { query: '', caseSensitive: false, regex: false } }}
      />
    )

    expect(previous.addon.clearDecorations).toHaveBeenCalledTimes(1)
    expect(previous.addon.findNext).toHaveBeenCalledWith('')
    expect(previous.dispose).toHaveBeenCalledTimes(1)
    next.emit({ resultIndex: 0, resultCount: 7 })
    previous.emit({ resultIndex: 2, resultCount: 3 })
    expect(view.getByText('1/7')).toBeTruthy()
  })

  it('clears the addon when the search portal unmounts', async () => {
    const { addon } = createSearchAddon()
    const view = renderSearch(addon, 'needle')
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())
    vi.mocked(addon.clearDecorations).mockClear()
    vi.mocked(addon.findNext).mockClear()

    view.unmount()

    expect(addon.clearDecorations).toHaveBeenCalledTimes(1)
    expect(addon.findNext).toHaveBeenCalledWith('')
  })

  it('exposes the search input for refocusing and clears its ref on close', () => {
    const { addon } = createSearchAddon()
    const inputRef: { current: HTMLInputElement | null } = { current: null }
    const searchStateRef = { current: { query: '', caseSensitive: false, regex: false } }
    const view = render(
      <TerminalSearch
        isOpen
        onClose={vi.fn()}
        searchAddon={addon}
        searchStateRef={searchStateRef}
        inputRef={inputRef}
      />
    )
    expect(inputRef.current).toBe(view.getByPlaceholderText('Search...'))
    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    view.rerender(
      <TerminalSearch
        isOpen={false}
        onClose={vi.fn()}
        searchAddon={addon}
        searchStateRef={searchStateRef}
        inputRef={inputRef}
      />
    )
    expect(inputRef.current).toBeNull()
    expect(addon.findNext).toHaveBeenLastCalledWith('')
  })
})
