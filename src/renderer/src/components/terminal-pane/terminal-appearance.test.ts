import { describe, expect, it, vi, afterEach } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import {
  applyTerminalAppearance,
  hexToRgba,
  publishTerminalViewAttributesAtAppStart
} from './terminal-appearance'
import {
  _resetPaneThemeIdentityForTest,
  capturePaneThemeAgent,
  getPaneThemeAgent
} from './pane-theme-identity'
import { maybePushMode2031Flip } from './terminal-mode-2031-replies'
import { safeFit } from '@/lib/pane-manager/pane-fit'
import { mode2031SequenceFor } from '../../../../shared/terminal-color-scheme-protocol'
import { _resetTerminalViewAttributesPublisherForTest } from './terminal-view-attributes-publisher'
import type { TerminalViewAttributesPush } from '../../../../shared/terminal-view-attributes'

function fakeTransport(overrides?: { connected?: boolean; sendOk?: boolean }): {
  isConnected: () => boolean
  sendInput: ReturnType<typeof vi.fn<(data: string) => boolean>>
  sendInputImmediate: ReturnType<typeof vi.fn<(data: string) => boolean>>
} {
  const connected = overrides?.connected ?? true
  const sendOk = overrides?.sendOk ?? true
  return {
    isConnected: () => connected,
    sendInput: vi.fn<(data: string) => boolean>(() => sendOk),
    sendInputImmediate: vi.fn<(data: string) => boolean>(() => sendOk)
  }
}

describe('mode2031SequenceFor', () => {
  it('maps dark to CSI ?997;1n and light to CSI ?997;2n', () => {
    expect(mode2031SequenceFor('dark')).toBe('\x1b[?997;1n')
    expect(mode2031SequenceFor('light')).toBe('\x1b[?997;2n')
  })
})

describe('maybePushMode2031Flip', () => {
  it('does nothing when the pane has not subscribed to mode 2031', () => {
    const transport = fakeTransport()
    const subs = new Map<number, boolean>()
    const last = new Map<number, 'dark' | 'light'>()

    const pushed = maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(pushed).toBe(false)
    expect(transport.sendInputImmediate).not.toHaveBeenCalled()
    expect(last.has(1)).toBe(false)
  })

  it('pushes the current mode once after subscribe and records it', () => {
    const transport = fakeTransport()
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    const pushed = maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(pushed).toBe(true)
    expect(transport.sendInputImmediate).toHaveBeenCalledTimes(1)
    expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[?997;1n')
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(last.get(1)).toBe('dark')
  })

  it('suppresses repeat pushes when the resolved mode has not changed', () => {
    // Spam-gate: applyTerminalAppearance re-runs on every font/opacity/cursor tweak; don't emit CSI 997 each time.
    const transport = fakeTransport()
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    maybePushMode2031Flip(1, 'dark', transport, subs, last)
    maybePushMode2031Flip(1, 'dark', transport, subs, last)
    maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(transport.sendInputImmediate).toHaveBeenCalledTimes(1)
    expect(last.get(1)).toBe('dark')
  })

  it('emits again when the theme actually flips', () => {
    const transport = fakeTransport()
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    maybePushMode2031Flip(1, 'dark', transport, subs, last)
    maybePushMode2031Flip(1, 'light', transport, subs, last)
    maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(transport.sendInputImmediate.mock.calls.map((c) => c[0])).toEqual([
      '\x1b[?997;1n',
      '\x1b[?997;2n',
      '\x1b[?997;1n'
    ])
    expect(last.get(1)).toBe('dark')
  })

  it('does not push when the transport is disconnected', () => {
    const transport = fakeTransport({ connected: false })
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    const pushed = maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(pushed).toBe(false)
    expect(transport.sendInputImmediate).not.toHaveBeenCalled()
    expect(last.has(1)).toBe(false)
  })

  it('leaves last-mode untouched when immediate input reports failure', () => {
    // So a reconnect / retry will re-emit on the next appearance pass.
    const transport = fakeTransport({ sendOk: false })
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    const pushed = maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(pushed).toBe(false)
    expect(transport.sendInputImmediate).toHaveBeenCalledTimes(1)
    expect(last.has(1)).toBe(false)
  })

  it('tracks flip state per-pane', () => {
    const transportA = fakeTransport()
    const transportB = fakeTransport()
    const subs = new Map([
      [1, true],
      [2, true]
    ])
    const last = new Map<number, 'dark' | 'light'>()

    maybePushMode2031Flip(1, 'dark', transportA, subs, last)
    maybePushMode2031Flip(2, 'light', transportB, subs, last)
    maybePushMode2031Flip(1, 'dark', transportA, subs, last) // suppressed
    maybePushMode2031Flip(2, 'dark', transportB, subs, last) // flip

    expect(transportA.sendInputImmediate).toHaveBeenCalledTimes(1)
    expect(transportB.sendInputImmediate).toHaveBeenCalledTimes(2)
    expect(last.get(1)).toBe('dark')
    expect(last.get(2)).toBe('dark')
  })
})
describe('applyTerminalAppearance theme assignment', () => {
  // xterm rebuilds the palette on any new theme-object identity (wiping OSC color mutations), so the assignment must be value-gated.
  // Measurable by default: metric options (fontSize/fontFamily/…) only land on
  // panes that can measure; unmeasurable panes defer them until fit/reveal.
  const CODEX_LEAF = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
  const CLAUDE_LEAF = '22222222-2222-4222-8222-222222222222' as TerminalLeafId
  const SHELL_LEAF = '33333333-3333-4333-8333-333333333333' as TerminalLeafId

  afterEach(() => {
    _resetPaneThemeIdentityForTest()
  })

  function makePane(
    id: number,
    overrides?: { measurable?: boolean; leafId?: TerminalLeafId }
  ): ManagedPane {
    const measurable = overrides?.measurable ?? true
    return {
      id,
      leafId: overrides?.leafId ?? (`00000000-0000-4000-8000-00000000000${id}` as TerminalLeafId),
      terminal: { options: {}, cols: 80, rows: 24 },
      container: {
        dataset: {},
        getBoundingClientRect: () => ({ width: measurable ? 800 : 0, height: measurable ? 600 : 0 })
      },
      fitAddon: {
        proposeDimensions: () => (measurable ? { cols: 80, rows: 24 } : undefined)
      }
    } as unknown as ManagedPane
  }

  function makeManager(panes: ManagedPane[]): PaneManager {
    return {
      // Mirrors the real getPanes(), which allocates a fresh toPublicPane()
      // wrapper per call over a shared terminal — per-pane state must survive that.
      getPanes: () => panes.map((pane) => ({ ...pane })),
      setPaneLigaturesEnabled: vi.fn(),
      setPaneStyleOptions: vi.fn()
    } as unknown as PaneManager
  }

  function apply(pane: ManagedPane, settings: ReturnType<typeof getDefaultSettings>): void {
    applyTerminalAppearance(
      makeManager([pane]),
      settings,
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
  }

  it('keeps options.theme identity across attribute-neutral applies (font size tweak)', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, settings)
    const firstTheme = pane.terminal.options.theme
    expect(firstTheme).toBeDefined()

    apply(pane, { ...settings, terminalFontSize: settings.terminalFontSize + 2 })

    // Identity-stable theme means xterm never re-runs _setTheme, so a TUI's modifyColors mutation survives the font tweak.
    expect(pane.terminal.options.theme).toBe(firstTheme)
    expect(pane.terminal.options.fontSize).toBe(settings.terminalFontSize + 2)
  })

  it('applies regular and bold font weights independently', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, terminalFontWeight: 400, terminalFontWeightBold: 800 })

    expect(pane.terminal.options.fontWeight).toBe(400)
    expect(pane.terminal.options.fontWeightBold).toBe(800)
  })

  it('still assigns a fresh theme when composed values actually change', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, settings)
    const firstTheme = pane.terminal.options.theme

    apply(pane, { ...settings, terminalColorOverrides: { background: '#102030' } })

    expect(pane.terminal.options.theme).not.toBe(firstTheme)
    expect(pane.terminal.options.theme?.background).toBe('#102030')
  })

  // #7934: contrast correction rescues invisible white text on light backgrounds but over-corrects on dark;
  // gate by the composed theme's background luminance (either theme slot can hold either kind of theme).
  it('keeps xterm contrast correction on light themes', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'light' })

    expect(pane.terminal.options.minimumContrastRatio).toBe(4.5)
  })

  it('applies the mild dark-background contrast floor on dark themes', () => {
    // #10104: a floor of 3 rescues near-background body text (e.g. Antigravity's #262b30 on #1e242a)
    // without the 4.5-floor over-brightening of vibrant ANSI colors that #7934 fixed.
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'dark' })

    expect(pane.terminal.options.minimumContrastRatio).toBe(3)
  })

  it('re-gates contrast correction when the theme flips live', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'light' })
    expect(pane.terminal.options.minimumContrastRatio).toBe(4.5)

    apply(pane, { ...settings, theme: 'dark' })
    expect(pane.terminal.options.minimumContrastRatio).toBe(3)
  })

  it('applies the dark-background floor in light mode when the terminal matches dark mode', () => {
    // terminalUseSeparateLightTheme=false keeps the dark terminal theme in light app mode; the gate must follow the background.
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'light', terminalUseSeparateLightTheme: false })

    expect(pane.terminal.options.minimumContrastRatio).toBe(3)
  })

  it('keeps contrast correction in dark mode when a light theme fills the dark slot', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'dark', terminalThemeDark: 'Builtin Tango Light' })

    expect(pane.terminal.options.minimumContrastRatio).toBe(4.5)
  })

  it('skips the minimumContrastRatio write on a no-op re-apply (preserves xterm contrast cache)', () => {
    const pane = makePane(1)
    let writes = 0
    let stored: number | undefined
    Object.defineProperty(pane.terminal.options, 'minimumContrastRatio', {
      configurable: true,
      enumerable: true,
      get: () => stored,
      set: (value: number) => {
        stored = value
        writes += 1
      }
    })
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'dark' })
    const writesAfterFirst = writes

    apply(pane, { ...settings, theme: 'dark' })

    // The value-gate must not rewrite an unchanged ratio — each write clears xterm's contrast cache.
    expect(writes).toBe(writesAfterFirst)
  })

  it('defers metric options on an unmeasurable pane and lands them on the next fit', () => {
    // A metric write makes xterm clear, resize and full-refresh; on a pane with
    // no usable box that repaint is wasted and the cols/rows re-fit that must
    // follow it cannot run. The write waits for a measurable pane.
    let measurable = false
    const pane = {
      id: 1,
      terminal: { options: {}, cols: 80, rows: 24 },
      container: {
        dataset: {},
        getBoundingClientRect: () => ({ width: measurable ? 800 : 0, height: measurable ? 600 : 0 })
      },
      fitAddon: {
        fit: vi.fn(),
        proposeDimensions: () => (measurable ? { cols: 80, rows: 24 } : undefined)
      }
    } as unknown as ManagedPane
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, terminalFontSize: 19 })

    expect(pane.terminal.options.fontSize).toBeUndefined()
    expect(pane.terminal.options.fontFamily).toBeUndefined()
    // Non-metric options are safe while hidden and must not be deferred with them.
    expect(pane.terminal.options.cursorStyle).toBeDefined()

    measurable = true
    safeFit(pane)

    expect(pane.terminal.options.fontSize).toBe(19)
    expect(pane.terminal.options.fontFamily).toContain('monospace')
  })

  it('applies only the latest deferred metric options after repeated hidden changes', () => {
    let measurable = false
    const writes: number[] = []
    const options: Record<string, unknown> = {}
    Object.defineProperty(options, 'fontSize', {
      configurable: true,
      enumerable: true,
      get: () => writes.at(-1),
      set: (value: number) => {
        writes.push(value)
      }
    })
    const pane = {
      id: 1,
      terminal: { options, cols: 80, rows: 24 },
      container: {
        dataset: {},
        getBoundingClientRect: () => ({ width: measurable ? 800 : 0, height: measurable ? 600 : 0 })
      },
      fitAddon: {
        fit: vi.fn(),
        proposeDimensions: () => (measurable ? { cols: 80, rows: 24 } : undefined)
      }
    } as unknown as ManagedPane
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, terminalFontSize: 15 })
    apply(pane, { ...settings, terminalFontSize: 21 })

    measurable = true
    safeFit(pane)

    // Latest wins, exactly one write: intermediate hidden values never touch xterm.
    expect(writes).toEqual([21])
  })

  it('paints Codex and shell panes different themes from the lifetime map, not a stub resolver', () => {
    const codexPane = makePane(1, { leafId: CODEX_LEAF })
    const shellPane = makePane(2, { leafId: SHELL_LEAF })
    capturePaneThemeAgent(CODEX_LEAF, { launchAgent: 'codex' }, 'codex')
    capturePaneThemeAgent(SHELL_LEAF, null, 'codex')
    const settings = {
      ...getDefaultSettings('/tmp'),
      agentTerminalThemes: { codex: { dark: 'Tokyo Night' } }
    }
    const manager = makeManager([codexPane, shellPane])
    const themeWrites: { id: number; background?: string }[] = []
    for (const pane of [codexPane, shellPane]) {
      let stored: (typeof pane.terminal.options)['theme']
      Object.defineProperty(pane.terminal.options, 'theme', {
        configurable: true,
        enumerable: true,
        get: () => stored,
        set: (value: (typeof pane.terminal.options)['theme']) => {
          themeWrites.push({ id: pane.id, background: value?.background })
          stored = value
        }
      })
    }

    applyTerminalAppearance(
      manager,
      settings,
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map(),
      (pane) => getPaneThemeAgent(pane.leafId)
    )

    expect(getPaneThemeAgent(CODEX_LEAF)).toBe('codex')
    expect(getPaneThemeAgent(SHELL_LEAF)).toBe(null)
    const codexTheme = codexPane.terminal.options.theme
    const shellTheme = shellPane.terminal.options.theme
    expect(codexTheme?.background).not.toBe(shellTheme?.background)
    expect(themeWrites.some((write) => write.id === 1)).toBe(true)
    expect(themeWrites.some((write) => write.id === 2)).toBe(true)

    applyTerminalAppearance(
      manager,
      settings,
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map(),
      (pane) => getPaneThemeAgent(pane.leafId)
    )
    expect(themeWrites).toHaveLength(2)
  })

  it('keeps three captured palettes after an unrelated font/opacity tweak', () => {
    const codexPane = makePane(1, { leafId: CODEX_LEAF })
    const claudePane = makePane(2, { leafId: CLAUDE_LEAF })
    const shellPane = makePane(3, { leafId: SHELL_LEAF })
    capturePaneThemeAgent(CODEX_LEAF, { launchAgent: 'codex' })
    capturePaneThemeAgent(CLAUDE_LEAF, { launchAgent: 'claude' })
    capturePaneThemeAgent(SHELL_LEAF, null, 'codex')
    const settings = {
      ...getDefaultSettings('/tmp'),
      agentTerminalThemes: {
        codex: { dark: 'Tokyo Night' },
        claude: { dark: 'Dracula' }
      }
    }
    const manager = makeManager([codexPane, claudePane, shellPane])
    applyTerminalAppearance(
      manager,
      settings,
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    const first = [
      codexPane.terminal.options.theme,
      claudePane.terminal.options.theme,
      shellPane.terminal.options.theme
    ]
    expect(new Set(first.map((theme) => theme?.background)).size).toBe(3)

    applyTerminalAppearance(
      manager,
      { ...settings, terminalFontSize: settings.terminalFontSize + 1, terminalInactivePaneOpacity: 0.5 },
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    expect(codexPane.terminal.options.theme).toBe(first[0])
    expect(claudePane.terminal.options.theme).toBe(first[1])
    expect(shellPane.terminal.options.theme).toBe(first[2])
  })
})

describe('publishTerminalViewAttributesAtAppStart', () => {
  // Hidden-at-launch PTYs query OSC 10/11 before any pane mounts; publish with no pane manager (terminal-query-authority.md).
  it('publishes composed attributes without any pane mount and dedupes repeats', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const sent: TerminalViewAttributesPush[] = []
    const send = (push: TerminalViewAttributesPush): boolean => {
      sent.push(push)
      return true
    }
    const settings = getDefaultSettings('/tmp')

    expect(publishTerminalViewAttributesAtAppStart(settings, true, send)).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.kind).toBe('snapshot')
    expect(sent[0]!.global.ansi).toHaveLength(256)
    expect(sent[0]!.global.cursorStyle).toBe(settings.terminalCursorStyle ?? 'block')

    expect(publishTerminalViewAttributesAtAppStart(settings, true, send)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('publishes one snapshot that includes global plus Codex byAgent', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const sent: TerminalViewAttributesPush[] = []
    const send = (push: TerminalViewAttributesPush): boolean => {
      sent.push(push)
      return true
    }
    const settings = {
      ...getDefaultSettings('/tmp'),
      agentTerminalThemes: { codex: { dark: 'Dracula' } }
    }

    expect(publishTerminalViewAttributesAtAppStart(settings, true, send)).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.kind).toBe('snapshot')
    expect(sent[0]!.byAgent.codex).toBeDefined()
    expect(sent[0]!.global.background).not.toEqual(sent[0]!.byAgent.codex?.background)
  })

  it('makes the later pane-mount applyTerminalAppearance a deduped no-op re-push', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const publishMock = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { pty: { publishTerminalViewAttributes: publishMock } }
    }
    try {
      const settings = getDefaultSettings('/tmp')
      publishTerminalViewAttributesAtAppStart(settings, true)
      expect(publishMock).toHaveBeenCalledTimes(1)

      // Identical app-global snapshot, so the publisher dedupe keeps it a single push.
      const manager = {
        getPanes: () => [],
        setPaneLigaturesEnabled: vi.fn(),
        setPaneStyleOptions: vi.fn()
      } as unknown as PaneManager
      applyTerminalAppearance(
        manager,
        settings,
        true,
        new Map(),
        new Map(),
        'false',
        new Map(),
        new Map()
      )
      expect(publishMock).toHaveBeenCalledTimes(1)
    } finally {
      delete (globalThis as { window?: unknown }).window
      _resetTerminalViewAttributesPublisherForTest()
    }
  })

  it('publishes nothing before settings are loaded', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const send = vi.fn(() => true)
    expect(publishTerminalViewAttributesAtAppStart(null, true, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('hexToRgba', () => {
  it('converts 6-char hex to rgba', () => {
    expect(hexToRgba('#1a1a1a', 0.72)).toBe('rgba(26, 26, 26, 0.72)')
  })

  it('converts 3-char shorthand hex to rgba', () => {
    expect(hexToRgba('#f0f', 0.5)).toBe('rgba(255, 0, 255, 0.5)')
  })

  it('handles full opacity', () => {
    expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)')
  })

  it('handles zero opacity', () => {
    expect(hexToRgba('#ffffff', 0)).toBe('rgba(255, 255, 255, 0)')
  })
})
