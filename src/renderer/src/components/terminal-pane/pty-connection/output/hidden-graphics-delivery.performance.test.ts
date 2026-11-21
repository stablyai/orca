import { Terminal } from '@xterm/xterm'
import { expect, it, vi } from 'vitest'
import { syncHiddenGraphicsDelivery } from './hidden-graphics-delivery'

vi.mock('@/lib/pane-manager/terminal-rendering/pane-inline-images', () => ({
  terminalHasStoredInlineImages: () => true
}))
vi.mock('@/store/index', () => ({ useAppStore: {} }))

// PR #44926: five hidden image panes previously bypassed output dropping at once.
it('bounds concurrent hidden graphics delivery and admits only at the start of a hide', () => {
  const panes = ['first', 'second', 'third', 'fourth', 'fifth'].map((ptyId) => ({
    ptyId,
    terminal: new Terminal()
  }))
  const [first, second, third, fourth, fifth] = panes
  const sync = (pane: (typeof panes)[number], hidden = true, canRetain = true): boolean =>
    syncHiddenGraphicsDelivery(pane, pane.terminal, pane.ptyId, hidden, canRetain)

  try {
    expect(panes.map((pane) => sync(pane))).toEqual([true, true, false, false, false])

    sync(first, false)
    expect(sync(third)).toBe(false)
    sync(third, false)
    expect(sync(third)).toBe(true)

    expect(sync(second, true, false)).toBe(false)
    expect(sync(second)).toBe(false)
    sync(fourth, false)
    expect(sync(fourth)).toBe(true)

    expect(syncHiddenGraphicsDelivery(third, third.terminal, 'rebound', true, true)).toBe(false)
    sync(fifth, false)
    expect(sync(fifth)).toBe(true)
  } finally {
    for (const pane of panes) {
      syncHiddenGraphicsDelivery(pane, pane.terminal, null, false, false)
      pane.terminal.dispose()
    }
  }
})
