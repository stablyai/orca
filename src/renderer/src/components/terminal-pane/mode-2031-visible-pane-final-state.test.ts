// Why: the visible-pane responder is xterm's CSI handler, which fires the
// instant `?2031h` is parsed. fish toggles 2031 on and off around every prompt
// in one PTY chunk, so the handler answers a subscription that is already gone
// by the time the reply reaches the tty — it lands as literal text (#9993).
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { installMode2031Handlers } from './terminal-appearance'

const ESC = '\x1b'

// One fish prompt cycle, exactly as fish's tty_handoff.rs emits it.
const FISH_PROMPT_HANDOFF = `${ESC}[?2031h${ESC}[0m~/orca ${ESC}[32m❯${ESC}[0m ${ESC}[?2031l`

function writeAndFlush(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve)
  })
}

function installOnFreshTerminal(): {
  terminal: Terminal
  onSubscribe: ReturnType<typeof vi.fn>
  paneMode2031: Map<number, boolean>
} {
  const terminal = new Terminal({ allowProposedApi: true })
  const onSubscribe = vi.fn()
  const paneMode2031 = new Map<number, boolean>()
  installMode2031Handlers({
    paneId: 1,
    parser: terminal.parser,
    onSubscribe,
    isReplaying: () => false,
    paneMode2031,
    paneLastThemeMode: new Map<number, 'dark' | 'light'>()
  })
  return { terminal, onSubscribe, paneMode2031 }
}

describe('visible-pane DECSET 2031 replies survive a fish prompt cycle (#9993)', () => {
  it('does not answer a subscribe the same chunk already withdrew', async () => {
    const { terminal, onSubscribe } = installOnFreshTerminal()

    await writeAndFlush(terminal, FISH_PROMPT_HANDOFF)

    expect(onSubscribe).not.toHaveBeenCalled()
  })

  it('leaves no stale subscription behind after the cycle', async () => {
    const { terminal, paneMode2031 } = installOnFreshTerminal()

    await writeAndFlush(terminal, FISH_PROMPT_HANDOFF)

    // A later theme flip must not push CSI 997 at an unsubscribed shell.
    expect(paneMode2031.get(1)).toBeUndefined()
  })

  it('still answers a TUI that subscribes and keeps listening', async () => {
    const { terminal, onSubscribe, paneMode2031 } = installOnFreshTerminal()

    await writeAndFlush(terminal, `${ESC}[?2031h`)

    expect(onSubscribe).toHaveBeenCalledTimes(1)
    expect(paneMode2031.get(1)).toBe(true)
  })

  it('answers once when a TUI starts up inside a fish prompt chunk', async () => {
    const { terminal, onSubscribe } = installOnFreshTerminal()

    // Prompt hands off, then a TUI launches and subscribes for real.
    await writeAndFlush(terminal, `${FISH_PROMPT_HANDOFF}${ESC}[?2031h`)

    expect(onSubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not answer across three fish prompts', async () => {
    const { terminal, onSubscribe } = installOnFreshTerminal()

    await writeAndFlush(terminal, FISH_PROMPT_HANDOFF)
    await writeAndFlush(terminal, FISH_PROMPT_HANDOFF)
    await writeAndFlush(terminal, FISH_PROMPT_HANDOFF)

    expect(onSubscribe).not.toHaveBeenCalled()
  })

  it('answers a subscribe whose unsubscribe never arrives in the same write', async () => {
    const { terminal, onSubscribe } = installOnFreshTerminal()

    // A real TUI: subscribe now, unsubscribe minutes later on exit.
    await writeAndFlush(terminal, `${ESC}[?2031h`)
    await writeAndFlush(terminal, 'painting the ui')

    expect(onSubscribe).toHaveBeenCalledTimes(1)
  })
})
