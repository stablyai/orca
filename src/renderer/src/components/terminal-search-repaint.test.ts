// @vitest-environment happy-dom

import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeFind } from './terminal-search-safe-find'

describe('terminal search after an in-place repaint', () => {
  let terminal: Terminal
  let search: SearchAddon

  beforeEach(() => {
    const measureText = vi.fn<CanvasRenderingContext2D['measureText']>()
    vi.mocked(measureText, { partial: true }).mockReturnValue({ width: 10 })
    vi.mocked(vi.spyOn(HTMLCanvasElement.prototype, 'getContext'), {
      partial: true
    }).mockReturnValue({ measureText })
    const container = document.createElement('div')
    document.body.appendChild(container)
    terminal = new Terminal({ cols: 40, rows: 5 })
    terminal.open(container)
    search = new SearchAddon()
    terminal.loadAddon(search)
  })

  afterEach(() => {
    terminal?.dispose()
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  function write(data: string): Promise<void> {
    return new Promise((resolve) => {
      const subscription = terminal.onWriteParsed(() => {
        subscription.dispose()
        resolve()
      })
      terminal.write(data)
    })
  }

  it.each(['findNext', 'findPrevious'] as const)(
    '%s searches current text when a redraw restores the same cursor position',
    async (direction) => {
      const find = (term: string): boolean =>
        safeFind((query, options) => search[direction](query, options), term)
      await write('OLD_TOKEN\r')
      expect(find('OLD_TOKEN')).toBe(true)
      expect(terminal.getSelection()).toBe('OLD_TOKEN')

      await write('\r\x1b[2KNEW_TOKEN\r')

      expect(find('OLD_TOKEN')).toBe(false)
      expect(find('NEW_TOKEN')).toBe(true)
      expect(terminal.getSelection()).toBe('NEW_TOKEN')

      await write('\x1b[2K')
      expect(find('NEW_TOKEN')).toBe(false)
    }
  )
})
