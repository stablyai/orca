// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function setPlatform(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createPaneDOM link tooltips', () => {
  it('anchors WebLinks hover text to the unpadded terminal window corner', () => {
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
    const pane = createPaneDOM(
      1,
      leafId,
      {},
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )

    expect(pane.linkTooltip.style.left).toBe('0px')
    expect(pane.linkTooltip.style.bottom).toBe('0px')
  })

  it('uses desktop modifier-click text for WebLinks hover hints', () => {
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId

    setPlatform('Macintosh')
    const macPane = createPaneDOM(
      1,
      leafId,
      {},
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )
    webLinksAddonMock.options?.hover?.({} as MouseEvent, 'http://localhost:5180/')
    expect(macPane.linkTooltip.textContent).toBe(
      'http://localhost:5180/ (⌘+click to open or ⇧⌘+click for system browser)'
    )

    setPlatform('Windows')
    const windowsPane = createPaneDOM(
      2,
      leafId,
      {},
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )
    webLinksAddonMock.options?.hover?.({} as MouseEvent, 'http://localhost:5180/')
    expect(windowsPane.linkTooltip.textContent).toBe(
      'http://localhost:5180/ (Ctrl+click to open or Shift+Ctrl+click for system browser)'
    )
  })

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
