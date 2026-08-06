/**
 * Repro for the frozen-terminal investigation (Discord #performance / #2836).
 *
 * The vendored xterm WriteBuffer (6.1.0-beta.287) permanently wedges when a
 * synchronous exception escapes a write-completion callback: `_innerWrite`
 * has no try/catch around `cb()`, the tail `_scheduleInnerWrite()` never
 * runs, and later `write()` calls only re-schedule processing when the
 * buffer is EMPTY — which a stalled buffer never is again.
 *
 * In Orca, write-completion callbacks run settleForegroundRender → refresh →
 * renderer/WebGL code (pane-terminal-foreground-render-settle.ts) and the
 * replay-guard decrement (replay-guard.ts). So one renderer exception during
 * write completion freezes that pane's output forever AND latches the replay
 * guard, whose gate in pty-connection.ts onData then silently drops every
 * keystroke — the exact live-shell/flat-output.log/frozen-pane state the
 * field reports describe. @xterm/headless shares the same WriteBuffer as
 * @xterm/xterm at the same pinned version.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'

describe('xterm WriteBuffer stall (vendored 6.1.0-beta.287)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('permanently stops completing writes after a sync throw in a write-completion callback', () => {
    vi.useFakeTimers()
    const term = new Terminal({ allowProposedApi: true })
    const completed: string[] = []

    term.write('first', () => {
      completed.push('first')
      throw new Error('synthetic renderer failure during write completion')
    })
    term.write('second', () => {
      completed.push('second')
    })

    expect(() => vi.runAllTimers()).toThrow('synthetic renderer failure')

    // The wedge: the stalled buffer is never empty again, so new writes only
    // enqueue — no drain is ever scheduled and no callback ever fires.
    term.write('third', () => {
      completed.push('third')
    })
    vi.runAllTimers()
    expect(completed).toEqual(['first'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('permanently stops completing writes after a sync throw in a custom parser handler', () => {
    // Orca registers custom CSI/OSC handlers (capability replies, titles,
    // agent status). The parser does NOT isolate sync handler exceptions:
    // they escape _action and wedge the buffer exactly like the callback
    // case — custom handlers are a second freeze vector.
    vi.useFakeTimers()
    const term = new Terminal({ allowProposedApi: true })
    const completed: string[] = []
    term.parser.registerCsiHandler({ final: 'z' }, () => {
      throw new Error('synthetic parser handler failure')
    })

    term.write('\x1b[z', () => {
      completed.push('poisoned')
    })
    term.write('after', () => {
      completed.push('after')
    })
    expect(() => vi.runAllTimers()).toThrow('synthetic parser handler failure')

    term.write('later', () => {
      completed.push('later')
    })
    vi.runAllTimers()
    expect(completed).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
