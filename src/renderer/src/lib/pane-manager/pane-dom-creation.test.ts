// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import { createPaneDOM } from './pane-dom-creation'

const webLinksAddonMock = vi.hoisted(() => ({
  options: null as { hover?: (event: MouseEvent, uri: string) => void; leave?: () => void } | null
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function FitAddon() {
    return {}
  })
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn().mockImplementation(function SearchAddon() {
    return {}
  })
}))

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: vi.fn().mockImplementation(function SerializeAddon() {
    return {}
  })
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: vi.fn().mockImplementation(function Unicode11Addon() {
    return {}
  })
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(function WebLinksAddon(_handler, options) {
    webLinksAddonMock.options = options
    return {}
  })
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function Terminal() {
    return {
      options: {},
      loadAddon: vi.fn(),
      open: vi.fn()
    }
  })
}))

describe('createPaneDOM link tooltips', () => {
  it('lets callers replace WebLinks hover text for display-only labels', async () => {
    const labeledText = 'http://main.orca.localhost:60016/ (localhost:5180; click to open)'
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
    const pane = createPaneDOM(
      1,
      leafId,
      {
        formatLinkTooltip: async () => labeledText
      },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )

    webLinksAddonMock.options?.hover?.({} as MouseEvent, 'http://localhost:5180/')
    await Promise.resolve()

    expect(pane.linkTooltip.textContent).toBe(labeledText)
  })
})
