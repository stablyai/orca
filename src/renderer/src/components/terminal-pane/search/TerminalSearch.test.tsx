// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SearchAddon } from '@xterm/addon-search'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalSearch from './TerminalSearch'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

type ResultsEvent = { resultIndex: number; resultCount: number }

function createSearchAddon(): { addon: SearchAddon } {
  const stub = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: (_handler: (payload: ResultsEvent) => void) => ({ dispose: vi.fn() })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The stub implements every addon member used by TerminalSearch.
  const addon = stub as unknown as SearchAddon
  return { addon }
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

describe('TerminalSearch whole-word matching', () => {
  it('forwards whole-word matching to the addon and keyboard search state', async () => {
    const { addon } = createSearchAddon()
    const searchStateRef = { current: { query: '', caseSensitive: false, regex: false } }
    const view = render(
      <TerminalSearch
        isOpen
        onClose={vi.fn()}
        searchAddon={addon}
        searchStateRef={searchStateRef}
      />
    )
    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'foo' } })
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())
    vi.mocked(addon.findNext).mockClear()

    const toggle = view.getByTitle('Match Whole Word')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(addon.findNext).toHaveBeenCalledWith(
        'foo',
        expect.objectContaining({ wholeWord: true, caseSensitive: false, regex: false })
      )
    )
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(searchStateRef.current).toEqual({
      query: 'foo',
      caseSensitive: false,
      regex: false,
      wholeWord: true
    })
  })

  it('invalidates the addon cache before re-searching the same query', async () => {
    const { addon } = createSearchAddon()
    const view = renderSearch(addon, 'cat')
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())
    vi.mocked(addon.clearDecorations).mockClear()
    vi.mocked(addon.findNext).mockClear()

    fireEvent.click(view.getByTitle('Match Whole Word'))

    await waitFor(() => expect(addon.findNext).toHaveBeenCalledTimes(1))
    expect(addon.clearDecorations).toHaveBeenCalledWith()
    expect(vi.mocked(addon.clearDecorations).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(addon.findNext).mock.invocationCallOrder[0]
    )
  })

  it('navigates matches on Enter only from the search input', async () => {
    const { addon } = createSearchAddon()
    const view = renderSearch(addon, 'foo')
    await waitFor(() => expect(addon.findNext).toHaveBeenCalled())
    vi.mocked(addon.findNext).mockClear()
    vi.mocked(addon.findPrevious).mockClear()

    const toggle = view.getByTitle('Match Whole Word')
    fireEvent.keyDown(toggle, { key: 'Enter' })
    fireEvent.keyDown(toggle, { key: 'Enter', shiftKey: true })
    expect(addon.findNext).not.toHaveBeenCalled()
    expect(addon.findPrevious).not.toHaveBeenCalled()

    const input = view.getByPlaceholderText('Search...')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(addon.findNext).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(addon.findPrevious).toHaveBeenCalledTimes(1)
  })
})
