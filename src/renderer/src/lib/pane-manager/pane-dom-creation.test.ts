// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import { createPaneDOM } from './pane-dom-creation'
import { terminalMouseEncodingRestoreAnsi } from './terminal-mouse-encoding-tracker'

const csiHandlers = vi.hoisted(() => new Map<string, (params: (number | number[])[]) => boolean>())

const webLinksAddonMock = vi.hoisted(() => ({
  handler: null as ((event: MouseEvent, uri: string) => void) | null,
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
  WebLinksAddon: vi.fn().mockImplementation(function WebLinksAddon(handler, options) {
    webLinksAddonMock.handler = handler
    webLinksAddonMock.options = options
    return {}
  })
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function Terminal() {
    return {
      options: {},
      loadAddon: vi.fn(),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      open: vi.fn(),
      parser: {
        registerCsiHandler: vi.fn(
          (id: { final: string }, handler: (params: (number | number[])[]) => boolean) => {
            csiHandlers.set(id.final, handler)
            return { dispose: vi.fn() }
          }
        ),
        registerEscHandler: vi.fn(() => ({ dispose: vi.fn() }))
      }
    }
  })
}))

describe('createPaneDOM link tooltips', () => {
  // Require caller hint wiring at compile time instead of silently falling back to stale copy.
  it('re-resolves the caller hint on every hover so setting changes apply live', () => {
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
    let hint = 'first hint'
    const pane = createPaneDOM(
      1,
      leafId,
      { linkOpenHint: () => hint },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )

    webLinksAddonMock.options?.hover?.({} as MouseEvent, 'http://localhost:5180/')
    expect(pane.linkTooltip.textContent).toBe('http://localhost:5180/ (first hint)')

    hint = 'second hint'
    webLinksAddonMock.options?.hover?.({} as MouseEvent, 'http://localhost:5180/')
    expect(pane.linkTooltip.textContent).toBe('http://localhost:5180/ (second hint)')
  })
})

describe('createPaneDOM mouse encoding', () => {
  it('tracks the encoding the pane terminal parses so its snapshot can carry it', () => {
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
    const pane = createPaneDOM(
      1,
      leafId,
      { linkOpenHint: () => 'open hint' },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )

    expect(csiHandlers.get('h')?.([1003, 1006])).toBe(false)
    expect(terminalMouseEncodingRestoreAnsi(pane.terminal)).toBe('\x1b[?1006h')
  })
})
