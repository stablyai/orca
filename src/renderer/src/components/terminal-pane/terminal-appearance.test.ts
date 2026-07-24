import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  applyTerminalAppearance,
  hexToRgba,
  installMode2031Handlers,
  publishTerminalViewAttributesAtAppStart
} from './terminal-appearance'
import { maybePushMode2031Flip } from './terminal-mode-2031-replies'
import { mode2031SequenceFor } from '../../../../shared/terminal-color-scheme-protocol'
import { replayIntoTerminal, type ReplayingPanesRef } from './replay-guard'
import { _resetTerminalViewAttributesPublisherForTest } from './terminal-view-attributes-publisher'
import type { TerminalViewAttributes } from '../../../../shared/terminal-view-attributes'

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
describe('installMode2031Handlers', () => {
  // Regression coverage for the "random characters on restart" bug: a replayed `CSI ?2031h` pushed `CSI ?997;1n` into the fresh shell.

  function writeSync(term: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => term.write(data, resolve))
  }

  function makeReplayingRef(): ReplayingPanesRef {
    return { current: new Map() } as ReplayingPanesRef
  }

  function setup(paneId = 1): {
    term: Terminal
    pane: ManagedPane
    replayingPanesRef: ReplayingPanesRef
    onSubscribe: ReturnType<typeof vi.fn>
    paneMode2031: Map<number, boolean>
    paneLastThemeMode: Map<number, 'dark' | 'light'>
    dispose: () => void
  } {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const pane = { id: paneId, terminal: term } as unknown as ManagedPane
    const replayingPanesRef = makeReplayingRef()
    const paneMode2031 = new Map<number, boolean>()
    const paneLastThemeMode = new Map<number, 'dark' | 'light'>()
    const onSubscribe = vi.fn()
    const disposables = installMode2031Handlers({
      paneId,
      parser: term.parser,
      onSubscribe,
      isReplaying: () => (replayingPanesRef.current.get(paneId) ?? 0) > 0,
      paneMode2031,
      paneLastThemeMode
    })
    return {
      term,
      pane,
      replayingPanesRef,
      onSubscribe,
      paneMode2031,
      paneLastThemeMode,
      dispose: () => {
        for (const d of disposables) {
          d.dispose()
        }
        term.dispose()
      }
    }
  }

  it('records subscribe and fires onSubscribe on a live `CSI ?2031h`', async () => {
    const h = setup()
    try {
      await writeSync(h.term, '\x1b[?2031h')
      expect(h.paneMode2031.get(1)).toBe(true)
      expect(h.onSubscribe).toHaveBeenCalledTimes(1)
    } finally {
      h.dispose()
    }
  })

  it('does NOT fire onSubscribe or record state when the sequence arrives during replay', async () => {
    // On cold restore the replay guard is set before xterm parses, so the handler must skip both the push and the bookkeeping.
    const h = setup()
    try {
      replayIntoTerminal(h.pane, h.replayingPanesRef, '\x1b[?2031h')
      // write() is async: the replay guard stays engaged until the write-completion callback fires.
      await new Promise<void>((resolve) => h.term.write('', resolve))

      expect(h.onSubscribe).not.toHaveBeenCalled()
      expect(h.paneMode2031.has(1)).toBe(false)
      expect(h.paneLastThemeMode.has(1)).toBe(false)
      // Once the replay window closes, the pane is not marked replaying.
      expect(h.replayingPanesRef.current.get(1) ?? 0).toBe(0)
    } finally {
      h.dispose()
    }
  })

  it('still honors a real `CSI ?2031h` received after a replay window closes', async () => {
    // A real `?2031h` from a TUI relaunched after cold restore must take effect normally.
    const h = setup()
    try {
      replayIntoTerminal(h.pane, h.replayingPanesRef, '\x1b[?2031h')
      await new Promise<void>((resolve) => h.term.write('', resolve))
      expect(h.onSubscribe).not.toHaveBeenCalled()

      await writeSync(h.term, '\x1b[?2031h')
      expect(h.paneMode2031.get(1)).toBe(true)
      expect(h.onSubscribe).toHaveBeenCalledTimes(1)
    } finally {
      h.dispose()
    }
  })

  it('clears subscribe state on `CSI ?2031l` regardless of replay state', async () => {
    // The `l` (unsubscribe) branch is intentionally not replay-guarded: clearing is harmless since we only send on subscribe.
    const h = setup()
    try {
      // Non-replay path: subscribe then unsubscribe clears state.
      await writeSync(h.term, '\x1b[?2031h')
      h.paneLastThemeMode.set(1, 'dark')
      expect(h.paneMode2031.get(1)).toBe(true)

      await writeSync(h.term, '\x1b[?2031l')
      expect(h.paneMode2031.has(1)).toBe(false)
      expect(h.paneLastThemeMode.has(1)).toBe(false)

      // Replay path: the `l` handler must still clear even during a replay window.
      await writeSync(h.term, '\x1b[?2031h')
      h.paneLastThemeMode.set(1, 'dark')
      expect(h.paneMode2031.get(1)).toBe(true)

      replayIntoTerminal(h.pane, h.replayingPanesRef, '\x1b[?2031l')
      await new Promise<void>((resolve) => h.term.write('', resolve))
      expect(h.paneMode2031.has(1)).toBe(false)
      expect(h.paneLastThemeMode.has(1)).toBe(false)
    } finally {
      h.dispose()
    }
  })

  it('returns `false` so compound DEC private modes still reach xterm', async () => {
    // Why: handlers return `false` so compound sequences like `CSI ?25;2031h` still reach xterm's built-in DEC private mode handler.
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const paneMode2031 = new Map<number, boolean>()
    const paneLastThemeMode = new Map<number, 'dark' | 'light'>()
    const onSubscribe = vi.fn()
    const returnValues: boolean[] = []
    // Cast: parser cb returns plain `boolean` but `Mode2031Parser` reflects xterm's `boolean | Promise<boolean>` (handlers here are sync).
    const spyParser: Parameters<typeof installMode2031Handlers>[0]['parser'] = {
      registerCsiHandler: (id, cb) =>
        term.parser.registerCsiHandler(id, (params) => {
          const r = cb(params) as boolean
          returnValues.push(r)
          return r
        })
    }
    const disposables = installMode2031Handlers({
      paneId: 1,
      parser: spyParser,
      onSubscribe,
      isReplaying: () => false,
      paneMode2031,
      paneLastThemeMode
    })
    try {
      // Compound: ?25 (cursor show) + ?2031 (color-scheme subscribe).
      await writeSync(term, '\x1b[?25;2031h')
      // Our 2031 recording fired:
      expect(paneMode2031.get(1)).toBe(true)
      expect(onSubscribe).toHaveBeenCalledTimes(1)
      // Every handler invocation returned `false`, so xterm's built-in DEC private mode handler still processes the sequence.
      expect(returnValues.length).toBeGreaterThan(0)
      expect(returnValues.every((v) => v === false)).toBe(true)
    } finally {
      for (const d of disposables) {
        d.dispose()
      }
      term.dispose()
    }
  })

  it('keeps per-pane state isolated when two panes share the parser API', async () => {
    // The subscribe bookkeeping map is shared across panes, so a replay on pane 1 must not leak into pane 2's live subscribe.
    const shared2031 = new Map<number, boolean>()
    const sharedLast = new Map<number, 'dark' | 'light'>()
    const replayingPanesRef = makeReplayingRef()

    const term1 = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const term2 = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const pane1 = { id: 1, terminal: term1 } as unknown as ManagedPane
    const onSub1 = vi.fn()
    const onSub2 = vi.fn()

    const d1 = installMode2031Handlers({
      paneId: 1,
      parser: term1.parser,
      onSubscribe: onSub1,
      isReplaying: () => (replayingPanesRef.current.get(1) ?? 0) > 0,
      paneMode2031: shared2031,
      paneLastThemeMode: sharedLast
    })
    const d2 = installMode2031Handlers({
      paneId: 2,
      parser: term2.parser,
      onSubscribe: onSub2,
      isReplaying: () => (replayingPanesRef.current.get(2) ?? 0) > 0,
      paneMode2031: shared2031,
      paneLastThemeMode: sharedLast
    })

    try {
      // Replay on pane 1 must not subscribe.
      replayIntoTerminal(pane1, replayingPanesRef, '\x1b[?2031h')
      await new Promise<void>((resolve) => term1.write('', resolve))
      expect(onSub1).not.toHaveBeenCalled()
      expect(shared2031.has(1)).toBe(false)

      // Live on pane 2 must subscribe normally.
      await writeSync(term2, '\x1b[?2031h')
      expect(onSub2).toHaveBeenCalledTimes(1)
      expect(shared2031.get(2)).toBe(true)
    } finally {
      for (const d of [...d1, ...d2]) {
        d.dispose()
      }
      term1.dispose()
      term2.dispose()
    }
  })
})

describe('applyTerminalAppearance theme assignment', () => {
  // xterm rebuilds the palette on any new theme-object identity (wiping OSC color mutations), so the assignment must be value-gated.
  function makePane(id: number): ManagedPane {
    return { id, terminal: { options: {}, cols: 80, rows: 24 } } as unknown as ManagedPane
  }

  function makeManager(panes: ManagedPane[]): PaneManager {
    return {
      getPanes: () => panes,
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
})

describe('publishTerminalViewAttributesAtAppStart', () => {
  // Hidden-at-launch PTYs query OSC 10/11 before any pane mounts; publish with no pane manager (terminal-query-authority.md).
  it('publishes composed attributes without any pane mount and dedupes repeats', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const sent: TerminalViewAttributes[] = []
    const send = (attributes: TerminalViewAttributes): boolean => {
      sent.push(attributes)
      return true
    }
    const settings = getDefaultSettings('/tmp')

    expect(publishTerminalViewAttributesAtAppStart(settings, true, send)).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.ansi).toHaveLength(256)
    expect(sent[0]!.cursorStyle).toBe(settings.terminalCursorStyle ?? 'block')

    expect(publishTerminalViewAttributesAtAppStart(settings, true, send)).toBe(false)
    expect(sent).toHaveLength(1)
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
