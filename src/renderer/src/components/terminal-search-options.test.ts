import { describe, expect, it, vi } from 'vitest'
import type { SearchAddon } from '@xterm/addon-search'
import { runTerminalSearchNavigation } from './terminal-pane/terminal-keyboard-shortcut-matching'

describe('terminal search navigation error boundary', () => {
  it.each(['next', 'previous'] as const)('preserves invalid regex errors for %s', (direction) => {
    const find = vi.fn(() => {
      throw new SyntaxError('Invalid regular expression')
    })
    const searchAddon = { findNext: find, findPrevious: find } as unknown as SearchAddon
    expect(() =>
      runTerminalSearchNavigation({ searchAddon }, direction, {
        query: '[',
        caseSensitive: false,
        regex: true
      })
    ).toThrow(SyntaxError)
    expect(find).toHaveBeenCalledWith(
      '[',
      expect.objectContaining({ regex: true, decorations: expect.any(Object) })
    )
  })

  it.each(['next', 'previous'] as const)(
    'contains only the decoration geometry failure for %s',
    (direction) => {
      const find = vi.fn(() => {
        throw new Error('This API only accepts positive integers')
      })
      const searchAddon = { findNext: find, findPrevious: find } as unknown as SearchAddon
      expect(
        runTerminalSearchNavigation({ searchAddon }, direction, {
          query: 'needle',
          caseSensitive: false,
          regex: false
        })
      ).toBe(false)
      find.mockImplementation(() => {
        throw new Error('other failure')
      })
      expect(() =>
        runTerminalSearchNavigation({ searchAddon }, direction, {
          query: 'needle',
          caseSensitive: false,
          regex: false
        })
      ).toThrow('other failure')
    }
  )
})
