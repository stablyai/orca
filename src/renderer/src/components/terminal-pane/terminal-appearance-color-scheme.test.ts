// @vitest-environment happy-dom

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { isPtyLocked, setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { applyTerminalAppearance } from './terminal-appearance'
import type { PtyTransport } from './pty-transport'

const PTY_ID = 'theme-pty'
const LEAF_ID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
const DARK = '\x1b[?997;1n'
const LIGHT = '\x1b[?997;2n'

// happy-dom cannot measure, so pin the fit to the terminal's own grid.
class FixedFitAddon extends FitAddon {
  override proposeDimensions(): { cols: number; rows: number } {
    return { cols: 80, rows: 24 }
  }
}

describe('applyTerminalAppearance mode-2031 color-scheme reports', () => {
  let terminal: Terminal
  let replies: string[]
  let subscriptions: Map<number, boolean>
  let lastModes: Map<number, 'dark' | 'light'>
  let resize: ReturnType<typeof vi.fn<PtyTransport['resize']>>
  let apply: (updates?: Partial<GlobalSettings>, systemPrefersDark?: boolean) => void

  const write = (data: string): Promise<void> =>
    new Promise((resolve) => terminal.write(data, resolve))

  beforeEach(() => {
    // happy-dom has no canvas text metrics; xterm measures glyphs on open().
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const context: CanvasRenderingContext2D = Object.create(null)
      context.measureText = () => Object.assign(Object.create(null), { width: 10 })
      return context
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const fitAddon = new FixedFitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    replies = []
    subscriptions = new Map()
    lastModes = new Map()
    resize = vi.fn<PtyTransport['resize']>(() => true)
    const record = (data: string): boolean => {
      replies.push(data)
      return true
    }
    const transport: PtyTransport = {
      connect: () => {},
      attach: () => {},
      disconnect: () => {},
      sendInput: record,
      sendInputImmediate: record,
      resize,
      isConnected: () => true,
      getPtyId: () => PTY_ID
    }
    // Mirrors pty-input-forward: xterm's own replies are dropped while mobile drives the PTY.
    terminal.onData((data) => {
      if (!isPtyLocked(PTY_ID)) {
        record(data)
      }
    })
    if (!isTerminalLeafId(LEAF_ID)) {
      throw new Error('fixture leaf id must be a UUID')
    }
    const pane: ManagedPane = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal,
      container: host,
      linkTooltip: document.createElement('div'),
      fitAddon,
      searchAddon: new SearchAddon(),
      serializeAddon: new SerializeAddon()
    }
    const manager = {
      getPanes: () => [pane],
      setPaneLigaturesEnabled: vi.fn(),
      setPaneInlineImagesEnabled: vi.fn(),
      setPaneStyleOptions: vi.fn()
    }
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      theme: 'system',
      terminalThemeDark: 'Ghostty Default Style Dark',
      terminalUseSeparateLightTheme: true,
      terminalThemeLight: 'Everforest Light'
    }
    apply = (updates = {}, systemPrefersDark = true) => {
      applyTerminalAppearance(
        manager,
        { ...settings, ...updates },
        systemPrefersDark,
        new Map(),
        new Map([[1, transport]]),
        'false',
        subscriptions,
        lastModes
      )
    }
    apply()
    resize.mockClear()
  })

  afterEach(() => {
    setDriverForPty(PTY_ID, { kind: 'idle' })
    setFitOverride(PTY_ID, 'desktop-fit', 80, 24)
    terminal.dispose()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  // What a visible pane sees: xterm parses DECSET 2031 and Orca records the subscription.
  async function subscribe(): Promise<void> {
    await write('\x1b[?2031h')
    subscriptions.set(1, true)
    lastModes.set(1, 'dark')
  }

  it('reports each light/dark flip exactly once', async () => {
    await subscribe()
    apply({}, false)
    expect(replies).toEqual([LIGHT])
    apply({}, true)
    expect(replies).toEqual([LIGHT, DARK])
  })

  it('reports the app mode once when the terminal palette has the opposite mode', async () => {
    await subscribe()
    apply({ theme: 'light', terminalThemeLight: 'Tango Dark' })
    expect(replies).toEqual([LIGHT])
    // xterm still answers an explicit ?996n query from the palette itself.
    replies.length = 0
    await write('\x1b[?996n')
    expect(replies).toEqual([DARK])
  })

  it('still reports a palette flip that keeps the app mode', async () => {
    await subscribe()
    apply({ terminalThemeDark: 'Everforest Light' })
    expect(replies).toEqual([LIGHT])
    // xterm's report, not Orca's: the app mode never flipped.
    expect(lastModes.get(1)).toBe('dark')
  })

  it('leaves the report to a mobile driver', async () => {
    await subscribe()
    setDriverForPty(PTY_ID, { kind: 'mobile', clientId: 'phone' })
    setFitOverride(PTY_ID, 'mobile-fit', 80, 24)
    apply({}, false)
    expect(replies).toEqual([])
    expect(lastModes.get(1)).toBe('dark')
  })

  it('reports to a desktop-driven PTY parked at another grid without resizing it', async () => {
    await subscribe()
    setFitOverride(PTY_ID, 'remote-desktop-fit', 80, 24)
    apply({}, false)
    expect(replies).toEqual([LIGHT])
    expect(resize).not.toHaveBeenCalled()
    // Once this desktop owns the grid again, the next appearance pass must not repeat the flip.
    setFitOverride(PTY_ID, 'desktop-fit', 80, 24)
    apply({ terminalFontSize: 20 }, false)
    expect(replies).toEqual([LIGHT])
  })

  it('keeps unrelated appearance changes silent and later palette reports working', async () => {
    await subscribe()
    apply()
    apply({ terminalFontSize: 20 })
    expect(replies).toEqual([])
    // The mute ends with the theme write: a program's own OSC 11 change is still xterm's to report.
    apply({}, false)
    replies.length = 0
    await write('\x1b]11;#000000\x1b\\')
    expect(replies).toEqual([DARK])
  })
})
