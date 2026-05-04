import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import {
  hexToRgba,
  installMode2031Handlers,
  maybePushMode2031Flip,
  mode2031SequenceFor
} from './terminal-appearance'
import { replayIntoTerminal, type ReplayingPanesRef } from './replay-guard'

function fakeTransport(overrides?: { connected?: boolean; sendOk?: boolean }): {
  isConnected: () => boolean
  sendInput: ReturnType<typeof vi.fn<(data: string) => boolean>>
} {
  const connected = overrides?.connected ?? true
  const sendOk = overrides?.sendOk ?? true
  return {
    isConnected: () => connected,
    sendInput: vi.fn<(data: string) => boolean>(() => sendOk)
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
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(last.has(1)).toBe(false)
  })

  it('pushes the current mode once after subscribe and records it', () => {
    const transport = fakeTransport()
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    const pushed = maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(pushed).toBe(true)
    expect(transport.sendInput).toHaveBeenCalledTimes(1)
    expect(transport.sendInput).toHaveBeenCalledWith('\x1b[?997;1n')
    expect(last.get(1)).toBe('dark')
  })

  it('suppresses repeat pushes when the resolved mode has not changed', () => {
    // This is the spam-gate: applyTerminalAppearance re-runs on every font /
    // opacity / cursor tweak, and we must not emit CSI 997 on each one.
    const transport = fakeTransport()
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    maybePushMode2031Flip(1, 'dark', transport, subs, last)
    maybePushMode2031Flip(1, 'dark', transport, subs, last)
    maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(transport.sendInput).toHaveBeenCalledTimes(1)
    expect(last.get(1)).toBe('dark')
  })

  it('emits again when the theme actually flips', () => {
    const transport = fakeTransport()
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    maybePushMode2031Flip(1, 'dark', transport, subs, last)
    maybePushMode2031Flip(1, 'light', transport, subs, last)
    maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(transport.sendInput.mock.calls.map((c) => c[0])).toEqual([
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
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(last.has(1)).toBe(false)
  })

  it('leaves last-mode untouched when sendInput reports failure', () => {
    // So a reconnect / retry will re-emit on the next appearance pass.
    const transport = fakeTransport({ sendOk: false })
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    const pushed = maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(pushed).toBe(false)
    expect(transport.sendInput).toHaveBeenCalledTimes(1)
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

    expect(transportA.sendInput).toHaveBeenCalledTimes(1)
    expect(transportB.sendInput).toHaveBeenCalledTimes(2)
    expect(last.get(1)).toBe('dark')
    expect(last.get(2)).toBe('dark')
  })
})
describe('installMode2031Handlers', () => {
  // Regression coverage for the "random characters on restart" bug: a restored
  // xterm buffer may contain `CSI ?2031h` emitted by the previous session's
  // TUI (e.g. Claude Code). Before the fix, replaying that buffer fired our
  // CSI handler and pushed `CSI ?997;1n` into the fresh shell via
  // transport.sendInput — zsh then echoed the literal `^[[?997;1n` onto the
  // prompt. These tests drive a real headless xterm parser so they cover the
  // actual parser path, not a mock.

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
    // This is the regression: on cold restore the serialized xterm buffer is
    // replayed through replayIntoTerminal, which sets the replay guard before
    // xterm parses the bytes. The handler must skip both the push (so no
    // CSI 997 leaks to the fresh shell) AND the bookkeeping (so a later theme
    // flip doesn't push either).
    const h = setup()
    try {
      replayIntoTerminal(h.pane, h.replayingPanesRef, '\x1b[?2031h')
      // write() is async-ish: the guard stays engaged until the
      // write-completion callback fires. Await parser completion.
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
    // If the user relaunches Claude Code after a cold restore, the real TUI
    // emits `?2031h` itself — that must take effect normally.
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
    // The `l` (unsubscribe) branch is intentionally not replay-guarded: a
    // serialized buffer ending in `?2031l` means the TUI unsubscribed before
    // shutdown, and clearing our stale bookkeeping is harmless — we only send
    // on subscribe, never on unsubscribe.
    const h = setup()
    try {
      // Non-replay path: subscribe then unsubscribe clears state.
      await writeSync(h.term, '\x1b[?2031h')
      h.paneLastThemeMode.set(1, 'dark')
      expect(h.paneMode2031.get(1)).toBe(true)

      await writeSync(h.term, '\x1b[?2031l')
      expect(h.paneMode2031.has(1)).toBe(false)
      expect(h.paneLastThemeMode.has(1)).toBe(false)

      // Replay path: resubscribe, then receive `?2031l` during a replay
      // window. The `l` handler must still clear — this is the invariant
      // promised by the test name.
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
    // Why: we return `false` from both handlers so compound sequences like
    // `CSI ?25;2031h` still go through xterm's built-in DEC private mode
    // handler. If a future refactor accidentally returned `true`, cursor
    // visibility (and any other unrelated mode sharing the sequence) would
    // desync. xterm's public API does not expose cursor visibility, so assert
    // the handler's return value directly via a spy wrapping the real parser.
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const paneMode2031 = new Map<number, boolean>()
    const paneLastThemeMode = new Map<number, 'dark' | 'light'>()
    const onSubscribe = vi.fn()
    const returnValues: boolean[] = []
    // Why the cast: the headless parser's registerCsiHandler callback
    // returns just `boolean`, but our `Mode2031Parser` type reflects xterm's
    // canonical `boolean | Promise<boolean>` signature. The spy wraps the
    // real parser and synchronously records whatever the wrapped handler
    // returned; in this codebase all mode-2031 handlers are synchronous.
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
      // And every invocation of our handler returned `false`, so xterm's
      // built-in DEC private mode handler still processes the sequence.
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
    // Each pane registers its own handlers on its own xterm parser, but the
    // subscribe bookkeeping map is shared across panes. A replay on pane 1
    // must not leak into pane 2's live subscribe.
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
