// @vitest-environment happy-dom
import React from 'react'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { it, expect, vi, afterEach } from 'vitest'
import TerminalSearch from '../../src/renderer/src/components/TerminalSearch'
import { runTerminalSearchNavigation } from '../../src/renderer/src/components/terminal-pane/terminal-keyboard-shortcut-matching'
vi.mock('@/i18n/i18n', () => ({ translate: (_key, fallback) => fallback }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})
it.each([
  ['Case sensitive', 'needle', 'needle\r\nNEEDLE\r\n', 2, 1],
  ['Regex', 'a.b', 'a.b\r\naxb\r\n', 1, 2]
])(
  'updates actual addon highlights when toggling %s without changing query',
  async (flag, query, content, initial, changed) => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    })
    const container = document.createElement('div')
    document.body.append(container)
    const terminal = new Terminal()
    terminal.open(container)
    const addon = new SearchAddon()
    terminal.loadAddon(addon)
    try {
      await new Promise((resolve) => terminal.write(content, resolve))
      const ref = { current: { query: '', caseSensitive: false, regex: false } }
      const view = render(
        React.createElement(TerminalSearch, {
          isOpen: true,
          onClose() {},
          searchAddon: addon,
          searchStateRef: ref
        })
      )
      fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: query } })
      expect(addon._resultTracker.searchResults.length).toBe(initial)
      fireEvent.click(view.getByTitle(flag))
      runTerminalSearchNavigation({ searchAddon: addon }, 'next', ref.current)
      expect(addon._state.lastSearchOptions[flag === 'Regex' ? 'regex' : 'caseSensitive']).toBe(
        true
      )
      const staleCount = addon._resultTracker.searchResults.length
      fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: `${query}x` } })
      fireEvent.change(view.getByPlaceholderText('Search...'), { target: { value: query } })
      expect(
        addon._resultTracker.searchResults.length,
        'query edit repairs highlights with current flags'
      ).toBe(changed)
      expect(staleCount, 'flag transition must update highlights before a query edit').toBe(changed)
    } finally {
      cleanup()
      terminal.dispose()
    }
  }
)
it.each(
  [false, true].flatMap((caseSensitive) =>
    [false, true].flatMap((regex) =>
      [false, true].map((wholeWord) => ({ caseSensitive, regex, wholeWord }))
    )
  )
)('retains initial option combination through navigation and write refresh: %j', async (flags) => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: () => ({ width: 10 })
  })
  const container = document.createElement('div')
  document.body.append(container)
  const terminal = new Terminal()
  terminal.open(container)
  const addon = new SearchAddon()
  terminal.loadAddon(addon)
  try {
    await new Promise((resolve) => terminal.write('needle\r\nNEEDLE\r\nneedles\r\n', resolve))
    const { createTerminalSearchOptions } =
      await import('../../src/renderer/src/components/terminal-search-options')
    const options = { ...createTerminalSearchOptions(flags), wholeWord: flags.wholeWord }
    const expected = 1 + Number(!flags.caseSensitive) + Number(!flags.wholeWord)
    addon.findNext('needle', options)
    addon.findPrevious('needle', options)
    expect(addon._resultTracker.searchResults.length).toBe(expected)
    await new Promise((resolve) => terminal.write('needle\r\n', resolve))
    await vi.waitFor(() => expect(addon._resultTracker.searchResults.length).toBe(expected + 1))
    expect(addon._state.lastSearchOptions).toMatchObject(flags)
  } finally {
    terminal.dispose()
  }
})

it.each(
  ['caseSensitive', 'regex', 'wholeWord'].flatMap((flag) =>
    ['findNext', 'findPrevious'].flatMap((direction) =>
      [false, true].map((initial) => ({ flag, direction, initial }))
    )
  )
)(
  'invalidates stable-query highlights and refresh policy: %j',
  async ({ flag, direction, initial }) => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    })
    const container = document.createElement('div')
    document.body.append(container)
    const terminal = new Terminal()
    terminal.open(container)
    const addon = new SearchAddon()
    terminal.loadAddon(addon)
    const query = flag === 'regex' ? 'a.b' : 'needle'
    const content =
      flag === 'regex'
        ? 'a.b\r\naxb\r\n'
        : flag === 'wholeWord'
          ? 'needle\r\nneedles\r\n'
          : 'needle\r\nNEEDLE\r\n'
    const count = (value) => (flag === 'regex' ? (value ? 2 : 1) : value ? 1 : 2)
    const { createTerminalSearchOptions } =
      await import('../../src/renderer/src/components/terminal-search-options')
    const options = (value) => ({
      ...createTerminalSearchOptions({ caseSensitive: false, regex: false }),
      [flag]: value
    })
    try {
      await new Promise((resolve) => terminal.write(content, resolve))
      addon[direction](query, options(initial))
      expect(addon._resultTracker.searchResults.length).toBe(count(initial))
      let resultEvent
      const subscription = addon.onDidChangeResults((event) => {
        resultEvent = { ...event, policy: addon._state.lastSearchOptions[flag] }
      })
      const changed = !initial
      addon[direction](query, options(changed))
      expect(addon._resultTracker.searchResults.length).toBe(count(changed))
      expect(resultEvent).toMatchObject({ resultCount: count(changed), policy: changed })
      expect(terminal.getSelection()).toBeTruthy()
      expect(addon._resultTracker.selectedDecoration).toBeDefined()
      addon[direction === 'findNext' ? 'findPrevious' : 'findNext'](query, options(changed))
      expect(addon._resultTracker.searchResults.length).toBe(count(changed))
      await new Promise((resolve) => terminal.write(content, resolve))
      await vi.waitFor(() =>
        expect(resultEvent).toMatchObject({ resultCount: count(changed) * 2, policy: changed })
      )
      expect(addon._resultTracker.searchResults.length).toBe(count(changed) * 2)
      addon[direction](`${query}z`, options(changed))
      expect(addon._resultTracker.searchResults.length).toBe(0)
      addon[direction](query, options(changed))
      expect(addon._resultTracker.searchResults.length).toBe(count(changed) * 2)
      addon[direction](query, options(initial))
      expect(addon._resultTracker.searchResults.length).toBe(count(initial) * 2)
      subscription.dispose()
    } finally {
      terminal.dispose()
    }
  }
)
