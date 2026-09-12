// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SearchAddon } from '@xterm/addon-search'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalSearch from './TerminalSearch'
import { TERMINAL_SEARCH_HIGHLIGHT_LIMIT } from './terminal-search-options'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

type ResultsListener = (event: { resultIndex: number; resultCount: number }) => void

const emitResults = new WeakMap<SearchAddon, ResultsListener>()

/**
 * Builds a stub addon whose `onDidChangeResults` listener is reachable through
 * `emitResults`, so a test can fire a result event the way xterm would.
 *
 * @returns A stub standing in for the pane's addon.
 */
function createSearchAddon(): SearchAddon {
  let listener: ResultsListener | undefined
  const addon = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn((next: ResultsListener) => {
      listener = next
      return { dispose: vi.fn() }
    })
  } as unknown as SearchAddon
  emitResults.set(addon, (event) => listener?.(event))
  return addon
}

/**
 * Renders an open find bar against one addon.
 *
 * @param searchAddon The addon the bar should search.
 * @returns The testing-library render result.
 */
function renderSearch(searchAddon: SearchAddon): ReturnType<typeof render> {
  return render(
    <TerminalSearch
      isOpen
      onClose={vi.fn()}
      searchAddon={searchAddon}
      searchStateRef={{ current: { query: '', caseSensitive: false, regex: false } }}
    />
  )
}

describe('TerminalSearch cleanup', () => {
  it('clears the current addon when the query is erased', async () => {
    const addon = createSearchAddon()
    const view = renderSearch(addon)

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())
    vi.mocked(addon.clearDecorations).mockClear()
    vi.mocked(addon.findNext).mockClear()

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: '' } })

    await waitFor(() => expect(addon.clearDecorations).toHaveBeenCalledTimes(1))
    expect(addon.findNext).toHaveBeenCalledWith('')
  })

  it('clears the previous addon when the search moves to another pane', async () => {
    const previousAddon = createSearchAddon()
    const nextAddon = createSearchAddon()
    const view = renderSearch(previousAddon)

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    await waitFor(() => expect(previousAddon.findNext).toHaveBeenCalled())
    vi.mocked(previousAddon.clearDecorations).mockClear()
    vi.mocked(previousAddon.findNext).mockClear()

    view.rerender(
      <TerminalSearch
        isOpen
        onClose={vi.fn()}
        searchAddon={nextAddon}
        searchStateRef={{ current: { query: '', caseSensitive: false, regex: false } }}
      />
    )

    expect(previousAddon.clearDecorations).toHaveBeenCalledTimes(1)
    expect(previousAddon.findNext).toHaveBeenCalledWith('')
  })

  it('clears the addon when the search portal unmounts', async () => {
    const addon = createSearchAddon()
    const view = renderSearch(addon)

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())
    vi.mocked(addon.clearDecorations).mockClear()
    vi.mocked(addon.findNext).mockClear()

    view.unmount()

    expect(addon.clearDecorations).toHaveBeenCalledTimes(1)
    expect(addon.findNext).toHaveBeenCalledWith('')
  })
})

describe('TerminalSearch match count', () => {
  it('reports matches found beyond the visible screen', async () => {
    const addon = createSearchAddon()
    const view = renderSearch(addon)

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())

    act(() => emitResults.get(addon)?.({ resultIndex: 2, resultCount: 47 }))

    await waitFor(() =>
      expect(view.container.querySelector('[data-terminal-search-match-count]')?.textContent).toBe(
        '3/47'
      )
    )
  })

  it('reports a zero result in red', async () => {
    const addon = createSearchAddon()
    const view = renderSearch(addon)

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())

    act(() => emitResults.get(addon)?.({ resultIndex: -1, resultCount: 0 }))

    await waitFor(() => {
      const counter = view.container.querySelector('[data-terminal-search-match-count]')
      expect(counter?.textContent).toBe('0/0')
      expect(counter?.className).toContain('text-red-400')
    })
  })

  it('shows a capped total instead of a zero index past the highlight limit', async () => {
    const addon = createSearchAddon()
    const view = renderSearch(addon)

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())

    act(() =>
      emitResults.get(addon)?.({
        resultIndex: -1,
        resultCount: TERMINAL_SEARCH_HIGHLIGHT_LIMIT
      })
    )

    await waitFor(() =>
      expect(view.container.querySelector('[data-terminal-search-match-count]')?.textContent).toBe(
        `${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+`
      )
    )
  })

  it('shows the bare total when no match is selected yet', async () => {
    const addon = createSearchAddon()
    const view = renderSearch(addon)

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())

    act(() => emitResults.get(addon)?.({ resultIndex: -1, resultCount: 12 }))

    await waitFor(() =>
      expect(view.container.querySelector('[data-terminal-search-match-count]')?.textContent).toBe(
        '12'
      )
    )
  })

  it('drops the count when the query is erased', async () => {
    const addon = createSearchAddon()
    const view = renderSearch(addon)

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())
    act(() => emitResults.get(addon)?.({ resultIndex: 0, resultCount: 3 }))

    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: '' } })

    await waitFor(() =>
      expect(view.container.querySelector('[data-terminal-search-match-count]')).toBeNull()
    )
  })
})
