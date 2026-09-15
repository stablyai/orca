// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SearchAddon } from '@xterm/addon-search'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalSearch from './TerminalSearch'
import {
  matchSearchNavigate,
  runTerminalSearchNavigation
} from './terminal-pane/terminal-keyboard-shortcut-matching'
import { FIND_QUERY_MAX_BYTES } from '@/lib/find-query-bounds'

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

describe('TerminalSearch option ownership', () => {
  it.each([true, false])(
    'shares committed flags and decorations with shortcuts (Mac=%s)',
    (isMac) => {
      const addon = createSearchAddon()
      const searchStateRef = { current: { query: '', caseSensitive: false, regex: false } }
      const view = render(
        <TerminalSearch
          isOpen
          onClose={vi.fn()}
          searchAddon={addon}
          searchStateRef={searchStateRef}
        />
      )
      const input = view.getByPlaceholderText('Search...')
      fireEvent.change(input, { target: { value: 'Needle.*' } })
      fireEvent.click(view.getByTitle('Case sensitive'))
      fireEvent.click(view.getByTitle('Regex'))
      const incremental = vi.mocked(addon.findNext).mock.calls.at(-1)![1]!
      expect(incremental).toEqual({
        caseSensitive: true,
        regex: true,
        incremental: true,
        decorations: {
          matchBackground: '#5c4a00',
          matchBorder: '#5c4a00',
          matchOverviewRuler: '#ffcc00',
          activeMatchBackground: '#c4580e',
          activeMatchBorder: '#ffcf6b',
          activeMatchColorOverviewRuler: '#ff9900'
        }
      })
      expect(searchStateRef.current).toEqual({
        query: 'Needle.*',
        caseSensitive: true,
        regex: true
      })
      for (const previous of [false, true]) {
        const find = previous ? addon.findPrevious : addon.findNext
        fireEvent.click(view.getByTitle(previous ? 'Previous match' : 'Next match'))
        expect(find).toHaveBeenLastCalledWith('Needle.*', { ...incremental, incremental: false })
        fireEvent.keyDown(input, { key: 'Enter', shiftKey: previous })
        expect(find).toHaveBeenLastCalledWith('Needle.*', { ...incremental, incremental: false })
        const direction = matchSearchNavigate(
          { key: 'g', metaKey: isMac, ctrlKey: !isMac, altKey: false, shiftKey: previous },
          isMac,
          true,
          searchStateRef.current
        )
        expect(direction).toBe(previous ? 'previous' : 'next')
        runTerminalSearchNavigation({ searchAddon: addon }, direction!, searchStateRef.current)
        expect(find).toHaveBeenLastCalledWith('Needle.*', { ...incremental, incremental: false })
      }
      fireEvent.click(view.getByTitle('Regex'))
      fireEvent.click(view.getByTitle('Case sensitive'))
      runTerminalSearchNavigation({ searchAddon: addon }, 'next', searchStateRef.current)
      expect(addon.findNext).toHaveBeenLastCalledWith('Needle.*', {
        ...incremental,
        caseSensitive: false,
        regex: false,
        incremental: false
      })
    }
  )

  it('bounds the React query and clears on close while retaining flags for reopen and replacement', () => {
    const addon = createSearchAddon()
    const replacement = createSearchAddon()
    const searchStateRef = { current: { query: '', caseSensitive: false, regex: false } }
    const props = { onClose: vi.fn(), searchStateRef }
    const view = render(<TerminalSearch {...props} isOpen searchAddon={addon} />)
    fireEvent.change(view.getByPlaceholderText('Search...'), {
      target: { value: 'x'.repeat(FIND_QUERY_MAX_BYTES + 1) }
    })
    expect(searchStateRef.current.query).toBe('')
    expect(addon.findNext).toHaveBeenLastCalledWith('')
    fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    fireEvent.click(view.getByTitle('Case sensitive'))
    view.rerender(<TerminalSearch {...props} isOpen={false} searchAddon={addon} />)
    expect(addon.findNext).toHaveBeenLastCalledWith('')
    view.rerender(<TerminalSearch {...props} isOpen searchAddon={replacement} />)
    expect(replacement.findNext).toHaveBeenLastCalledWith(
      'needle',
      expect.objectContaining({
        caseSensitive: true,
        incremental: true,
        decorations: expect.any(Object)
      })
    )
    view.unmount()
    expect(replacement.findNext).toHaveBeenLastCalledWith('')
  })
})
