/**
 * View-attribute bridge publication (terminal-query-authority.md §View-
 * attribute bridge): the composed snapshot must mirror xterm ThemeService
 * resolution (defaults, cursor blend, 256-entry palette), and pushes must
 * happen once per actual change — not per pane, not per font tweak.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import { applyTerminalAppearance } from './terminal-appearance'
import {
  _resetTerminalViewAttributesPublisherForTest,
  composeTerminalViewAttributes,
  publishTerminalViewAttributes
} from './terminal-view-attributes-publisher'

const cursorSettings = {
  terminalCursorStyle: 'block' as const,
  terminalCursorBlink: true
}

beforeEach(() => {
  _resetTerminalViewAttributesPublisherForTest()
  vi.unstubAllGlobals()
})

describe('composeTerminalViewAttributes', () => {
  it('resolves a null theme to the xterm ThemeService defaults', () => {
    const attrs = composeTerminalViewAttributes(null, 'dark', cursorSettings)
    expect(attrs.foreground).toEqual([0xff, 0xff, 0xff])
    expect(attrs.background).toEqual([0x00, 0x00, 0x00])
    expect(attrs.cursor).toEqual([0xff, 0xff, 0xff])
    expect(attrs.ansi).toHaveLength(256)
    // DEFAULT_ANSI_COLORS parity: named 16, color cube, greys.
    expect(attrs.ansi[0]).toEqual([0x2e, 0x34, 0x36])
    expect(attrs.ansi[1]).toEqual([0xcc, 0x00, 0x00])
    expect(attrs.ansi[15]).toEqual([0xee, 0xee, 0xec])
    expect(attrs.ansi[16]).toEqual([0x00, 0x00, 0x00])
    expect(attrs.ansi[196]).toEqual([0xff, 0x00, 0x00])
    expect(attrs.ansi[232]).toEqual([8, 8, 8])
    expect(attrs.ansi[255]).toEqual([238, 238, 238])
    expect(attrs.colorSchemeMode).toBe('dark')
    expect(attrs.cursorStyle).toBe('block')
    expect(attrs.cursorBlink).toBe(true)
  })

  it('parses composed theme colors including rgba() opacity forms', () => {
    const attrs = composeTerminalViewAttributes(
      {
        // composeActiveTerminalTheme emits rgba() when terminalBackgroundOpacity
        // or terminalCursorOpacity apply; the reply drops alpha like xterm's
        // toColorRGB, except the cursor which blends over the background.
        background: 'rgba(30, 30, 46, 0.9)',
        foreground: '#d0d0d0',
        cursor: 'rgba(255, 0, 0, 0.5)',
        red: '#ff8800'
      },
      'light',
      { terminalCursorStyle: 'underline', terminalCursorBlink: false }
    )
    expect(attrs.background).toEqual([30, 30, 46])
    expect(attrs.foreground).toEqual([0xd0, 0xd0, 0xd0])
    // color.blend parity: a = round(0.5*255)/255; ch = bg + round((fg-bg)*a).
    expect(attrs.cursor).toEqual([143, 15, 23])
    expect(attrs.ansi[1]).toEqual([0xff, 0x88, 0x00])
    expect(attrs.colorSchemeMode).toBe('light')
    expect(attrs.cursorStyle).toBe('underline')
    expect(attrs.cursorBlink).toBe(false)
  })

  it('keeps an opaque cursor un-blended and blends short-hex alpha', () => {
    const attrs = composeTerminalViewAttributes(
      { background: '#000000', cursor: '#ff0000' },
      'dark',
      cursorSettings
    )
    expect(attrs.cursor).toEqual([255, 0, 0])

    const blended = composeTerminalViewAttributes(
      { background: '#000000', cursor: '#f00a' },
      'dark',
      cursorSettings
    )
    // #f00a → alpha 0xaa: 0 + round(255 * (0xaa/0xff)) = 170.
    expect(blended.cursor).toEqual([170, 0, 0])
  })

  it('overlays extendedAnsi onto the default 256 palette tail', () => {
    const attrs = composeTerminalViewAttributes(
      { extendedAnsi: ['#102030'] },
      'dark',
      cursorSettings
    )
    expect(attrs.ansi[16]).toEqual([0x10, 0x20, 0x30])
    // Untouched tail entries stay on the generated cube.
    expect(attrs.ansi[17]).toEqual([0x00, 0x00, 0x5f])
  })

  it('falls back to slot defaults for named colors (hand-edited settings divergence)', () => {
    // A visible pane resolves named CSS via canvas; the composer cannot, so
    // hand-edited values fall back — the documented divergence boundary.
    const attrs = composeTerminalViewAttributes(
      { red: 'darkred', foreground: 'hotpink' },
      'dark',
      cursorSettings
    )
    expect(attrs.ansi[1]).toEqual([0xcc, 0x00, 0x00])
    expect(attrs.foreground).toEqual([0xff, 0xff, 0xff])
  })
})

describe('publishTerminalViewAttributes dedupe', () => {
  it('publishes once per snapshot change, not per call', () => {
    const send = vi.fn(() => true)
    expect(publishTerminalViewAttributes(null, 'dark', cursorSettings, send)).toBe(true)
    expect(publishTerminalViewAttributes(null, 'dark', cursorSettings, send)).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)

    // A real attribute change (theme flip) publishes again.
    expect(publishTerminalViewAttributes(null, 'light', cursorSettings, send)).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not record a failed send, so the next call retries', () => {
    const failingSend = vi.fn(() => false)
    expect(publishTerminalViewAttributes(null, 'dark', cursorSettings, failingSend)).toBe(false)

    const send = vi.fn(() => true)
    expect(publishTerminalViewAttributes(null, 'dark', cursorSettings, send)).toBe(true)
  })

  it('skips silently when the preload bridge is unavailable (web client, tests)', () => {
    // No window stub: default send must be a safe no-op.
    expect(publishTerminalViewAttributes(null, 'dark', cursorSettings)).toBe(false)
  })
})

describe('applyTerminalAppearance publication', () => {
  function makePane(id: number): ManagedPane {
    return {
      id,
      terminal: { options: {}, cols: 80, rows: 24 }
    } as unknown as ManagedPane
  }

  function makeManager(panes: ManagedPane[]): PaneManager {
    return {
      getPanes: () => panes,
      setPaneLigaturesEnabled: vi.fn(),
      setPaneStyleOptions: vi.fn()
    } as unknown as PaneManager
  }

  function stubPublishBridge(): ReturnType<typeof vi.fn> {
    const publish = vi.fn<(attributes: TerminalViewAttributes) => void>()
    vi.stubGlobal('window', { api: { pty: { publishTerminalViewAttributes: publish } } })
    return publish
  }

  it('pushes the app-global snapshot once per change, not per pane or per manager', () => {
    const publish = stubPublishBridge()
    const settings = getDefaultSettings('/tmp')

    // Two panes in one manager plus a second manager (another tab): the
    // attributes are app-global, so identical applies publish exactly once.
    applyTerminalAppearance(
      makeManager([makePane(1), makePane(2)]),
      settings,
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    applyTerminalAppearance(
      makeManager([makePane(3)]),
      settings,
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    expect(publish).toHaveBeenCalledTimes(1)
    const attributes = publish.mock.calls[0][0] as TerminalViewAttributes
    expect(attributes.ansi).toHaveLength(256)
    expect(attributes.cursorStyle).toBe(settings.terminalCursorStyle)

    // Attribute-neutral tweak (font size) must not re-push…
    applyTerminalAppearance(
      makeManager([makePane(1)]),
      { ...settings, terminalFontSize: settings.terminalFontSize + 2 },
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    expect(publish).toHaveBeenCalledTimes(1)

    // …while a cursor-style change is a real attribute change.
    applyTerminalAppearance(
      makeManager([makePane(1)]),
      { ...settings, terminalCursorStyle: 'underline' },
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('publishes the resolved color-scheme mode flip (system dark toggle)', () => {
    const publish = stubPublishBridge()
    const settings = { ...getDefaultSettings('/tmp'), theme: 'system' as const }

    applyTerminalAppearance(
      makeManager([makePane(1)]),
      settings,
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    applyTerminalAppearance(
      makeManager([makePane(1)]),
      settings,
      false,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )

    const modes = publish.mock.calls.map(
      (call) => (call[0] as TerminalViewAttributes).colorSchemeMode
    )
    expect(modes).toEqual(['dark', 'light'])
  })
})
