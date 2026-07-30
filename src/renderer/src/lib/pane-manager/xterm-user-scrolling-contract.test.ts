/**
 * Contract test for xterm's native user-scrolling ownership (vendored
 * 6.1.0-beta.287; @xterm/headless shares BufferService with @xterm/xterm).
 *
 * Orca's live PTY write path performs NO scroll-intent enforcement — it
 * relies on xterm core keeping a scrolled-up viewport stable and following
 * output at the bottom (BufferService.isUserScrolling, consumed atomically
 * inside scroll()). App-side enforcement is scoped to structural operations
 * (snapshot replay, remount, fit reflow) in terminal-scroll-intent.ts.
 *
 * If an xterm upgrade breaks any assertion here, the live write path loses
 * its follow/pin semantics silently — fix the write path before bumping.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import packageJson from '../../../../../package.json'
import { clearTerminalScrollbackAndFollowOutput } from './terminal-scrollback-clear'

type TerminalWithBufferService = Terminal & {
  _core?: {
    _bufferService?: { isUserScrolling?: boolean }
    coreService?: { onUserInput?: (listener: () => void) => { dispose: () => void } }
  }
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function writeLines(term: Terminal, count: number, label: string): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await write(term, `${label}${i}\r\n`)
  }
}

describe('xterm native user-scrolling contract (vendored 6.1.0-beta.287)', () => {
  it('pins headless and renderer xterm to the same version', () => {
    expect(packageJson.dependencies['@xterm/headless']).toBe(
      packageJson.devDependencies['@xterm/xterm']
    )
  })

  it('keeps a scrolled-up viewport stable while output is written', async () => {
    const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000, allowProposedApi: true })
    await writeLines(term, 30, 'line')
    const buffer = term.buffer.active
    expect(buffer.viewportY).toBe(buffer.baseY)

    term.scrollLines(-5)
    const pinnedY = buffer.viewportY
    expect(pinnedY).toBe(buffer.baseY - 5)

    await writeLines(term, 10, 'more')
    expect(buffer.viewportY).toBe(pinnedY)
    expect(buffer.baseY).toBe(pinnedY + 15)
  })

  it('treats a viewport one row above bottom as user-scrolling through output', async () => {
    const term = new Terminal({
      rows: 10,
      cols: 40,
      scrollback: 1000,
      allowProposedApi: true
    }) as TerminalWithBufferService
    await writeLines(term, 30, 'line')
    const buffer = term.buffer.active

    term.scrollLines(-1)
    const pinnedY = buffer.viewportY
    expect(pinnedY).toBe(buffer.baseY - 1)
    expect(term._core?._bufferService?.isUserScrolling).toBe(true)

    await writeLines(term, 5, 'more')
    expect(buffer.viewportY).toBe(pinnedY)
  })

  it('follows output at the bottom and re-follows after scrolling back down', async () => {
    const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000, allowProposedApi: true })
    await writeLines(term, 30, 'line')
    const buffer = term.buffer.active

    await writeLines(term, 5, 'tail')
    expect(buffer.viewportY).toBe(buffer.baseY)

    term.scrollLines(-5)
    term.scrollToBottom()
    await writeLines(term, 5, 'after')
    expect(buffer.viewportY).toBe(buffer.baseY)
  })

  it('applies scrollOnUserInput before notifying onData listeners', async () => {
    const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000, allowProposedApi: true })
    await writeLines(term, 30, 'line')
    const buffer = term.buffer.active
    term.scrollLines(-5)
    let viewportSeenByOnData = -1
    const subscription = term.onData(() => {
      viewportSeenByOnData = buffer.viewportY
    })

    term.input('a', true)

    // Why: Orca resyncs typing intent synchronously from onData, so this
    // xterm ordering is part of the pinned-version contract.
    expect(viewportSeenByOnData).toBe(buffer.baseY)
    subscription.dispose()
  })

  it('distinguishes real user input from parser auto-replies', async () => {
    const term = new Terminal({
      rows: 10,
      cols: 40,
      allowProposedApi: true
    }) as TerminalWithBufferService
    expect(term._core?.coreService?.onUserInput).toBeTypeOf('function')
    let userInputCount = 0
    const subscription = term._core?.coreService?.onUserInput?.(() => {
      userInputCount += 1
    })

    term.input('a', true)
    await write(term, '\x1b[6n')

    expect(userInputCount).toBe(1)
    subscription?.dispose()
  })

  it('walks a pinned viewport down content-stably when scrollback trims', async () => {
    const term = new Terminal({ rows: 5, cols: 20, scrollback: 20, allowProposedApi: true })
    await writeLines(term, 30, 'x')
    const buffer = term.buffer.active
    term.scrollLines(-10)
    const pinnedY = buffer.viewportY
    const fullBaseY = buffer.baseY

    await writeLines(term, 10, 'trim')
    // Buffer is at capacity: baseY stays put while each trimmed line shifts
    // the pinned viewport up by one so the visible content does not move.
    expect(buffer.baseY).toBe(fullBaseY)
    expect(buffer.viewportY).toBe(Math.max(0, pinnedY - 10))
  })

  it('exposes the isUserScrolling flag the structural restore paths depend on', async () => {
    const term = new Terminal({
      rows: 10,
      cols: 40,
      scrollback: 1000,
      allowProposedApi: true
    }) as TerminalWithBufferService
    await writeLines(term, 30, 'line')
    const bufferService = term._core?._bufferService
    expect(typeof bufferService?.isUserScrolling).toBe('boolean')

    // scrollLines/scrollToBottom self-manage the flag, so Orca's programmatic
    // scroll restores inherit xterm's native live-output ownership.
    expect(bufferService?.isUserScrolling).toBe(false)
    term.scrollLines(-5)
    expect(bufferService?.isUserScrolling).toBe(true)
    term.scrollToBottom()
    expect(bufferService?.isUserScrolling).toBe(false)
  })

  it('resets native user-scrolling when a pinned scrollback is cleared', async () => {
    const term = new Terminal({
      rows: 10,
      cols: 40,
      scrollback: 1000,
      allowProposedApi: true
    }) as TerminalWithBufferService
    await writeLines(term, 30, 'line')
    term.scrollLines(-5)
    expect(term._core?._bufferService?.isUserScrolling).toBe(true)

    clearTerminalScrollbackAndFollowOutput(term)
    expect(term.buffer.active.viewportY).toBe(0)
    expect(term.buffer.active.baseY).toBe(0)
    expect(term._core?._bufferService?.isUserScrolling).toBe(false)

    await writeLines(term, 15, 'after-clear')
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
  })
})
