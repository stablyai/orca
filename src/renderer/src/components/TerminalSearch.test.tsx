// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SearchAddon } from '@xterm/addon-search'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalSearch from './TerminalSearch'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

function createSearchAddon(): SearchAddon {
  return {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn()
  } as unknown as SearchAddon
}

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
