// @vitest-environment happy-dom

import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { getBuiltinTheme } from '@/lib/terminal-theme'
import type { RepoTerminalThemeOverrides } from '../../../../shared/repo-terminal-theme'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { applyTerminalAppearance } from './terminal-appearance'
import { _resetTerminalViewAttributesPublisherForTest } from './terminal-view-attributes-publisher'
import { parseTerminalCssColor } from '../../../../shared/terminal-css-color'
import { terminalViewRgbToCssHex } from '../../../../shared/terminal-view-attributes'

// Exercises applyTerminalAppearance against a REAL opened xterm so the
// oracle is what xterm itself reports (its built-in OSC 11 query reply reads the live
// ThemeService colours, including TUI OSC SET overlays), not a mock's option bag.

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

async function queryBackground(terminal: Terminal): Promise<string> {
  let reply = ''
  const sub = terminal.onData((data) => {
    reply += data
  })
  await write(terminal, '\x1b]11;?\x07')
  sub.dispose()
  const match = /\]11;rgb:([0-9a-f]{2})[0-9a-f]*\/([0-9a-f]{2})[0-9a-f]*\/([0-9a-f]{2})/i.exec(
    reply
  )
  if (!match) {
    throw new Error(`no OSC 11 reply: ${JSON.stringify(reply)}`)
  }
  return `#${match[1]}${match[2]}${match[3]}`.toLowerCase()
}

type Harness = { pane: ManagedPane; manager: PaneManager; terminal: Terminal }

function makeHarness(): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  terminal.open(host)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the pane members appearance reads; a 0x0 box keeps fit/metric paths inert.
  const pane = {
    id: 1,
    terminal,
    container: { dataset: {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) },
    xtermContainer: host,
    fitAddon: { proposeDimensions: () => undefined }
  } as unknown as ManagedPane
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the manager members appearance reads.
  const manager = {
    getPanes: () => [pane],
    setPaneLigaturesEnabled: vi.fn(),
    setPaneInlineImagesEnabled: vi.fn(),
    setPaneStyleOptions: vi.fn()
  } as unknown as PaneManager
  return { pane, manager, terminal }
}

function apply(
  h: Harness,
  settings: GlobalSettings,
  pick: RepoTerminalThemeOverrides | undefined
): void {
  applyTerminalAppearance(
    h.manager,
    settings,
    true,
    new Map(),
    new Map(),
    'false',
    new Map(),
    new Map(),
    pick
  )
}

function darkSettings(): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), theme: 'dark' }
}

function hex(themeName: string): string {
  const bg = getBuiltinTheme(themeName)?.background
  if (!bg) {
    throw new Error(`no theme ${themeName}`)
  }
  return bg.toLowerCase()
}

describe('repo terminal theme on a real xterm', () => {
  const harnesses: Harness[] = []
  const make = (): Harness => {
    const h = makeHarness()
    harnesses.push(h)
    return h
  }

  beforeEach(() => {
    _resetTerminalViewAttributesPublisherForTest()
    vi.stubGlobal('api', { pty: { publishTerminalViewAttributes: vi.fn() } })
    // happy-dom has no canvas; xterm measures glyphs and parses non-hex CSS colours through one.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm only touches these members in happy-dom.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 }),
      fillStyle: '#000000',
      fillRect: () => {},
      clearRect: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    for (const h of harnesses.splice(0)) {
      h.terminal.dispose()
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
    _resetTerminalViewAttributesPublisherForTest()
  })

  it("xterm's own OSC 11 reply in a themed pane reports the project background", async () => {
    const h = make()
    apply(h, darkSettings(), { dark: 'Dracula' })
    expect(await queryBackground(h.terminal)).toBe(hex('Dracula'))
  })

  it('a TUI OSC 11 overlay survives a re-apply with an equal pick of NEW identity (repo row churn)', async () => {
    const h = make()
    const settings = darkSettings()
    apply(h, settings, { dark: 'Dracula' })
    const themeRef = h.terminal.options.theme
    await write(h.terminal, '\x1b]11;#123456\x07')
    expect(await queryBackground(h.terminal)).toBe('#123456')
    // A refetched repo row hands the host-state memo a structurally-equal but new object.
    apply(h, settings, { dark: 'Dracula' })
    apply(h, { ...settings }, { dark: 'Dracula' })
    expect(h.terminal.options.theme).toBe(themeRef)
    expect(await queryBackground(h.terminal)).toBe('#123456')
  })

  it('reports an out-of-range rgb() background exactly as the hidden reply parser does', async () => {
    const h = make()
    h.terminal.options.theme = { background: 'rgb(300, 0, 999)' }
    const parsed = parseTerminalCssColor('rgb(300, 0, 999)')
    expect(parsed).not.toBeNull()
    expect(await queryBackground(h.terminal)).toBe(
      terminalViewRgbToCssHex(parsed?.rgb ?? [0, 0, 0])
    )
  })

  it('an unrelated settings write (cursor blink) keeps the TUI overlay in a themed pane', async () => {
    const h = make()
    const settings = darkSettings()
    apply(h, settings, { dark: 'Dracula' })
    await write(h.terminal, '\x1b]11;#123456\x07')
    apply(
      h,
      { ...settings, terminalCursorBlink: !settings.terminalCursorBlink },
      { dark: 'Dracula' }
    )
    expect(await queryBackground(h.terminal)).toBe('#123456')
  })
})
