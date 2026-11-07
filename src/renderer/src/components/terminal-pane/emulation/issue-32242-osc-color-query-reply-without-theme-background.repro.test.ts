import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { installTerminalCapabilityReplyHandlers } from './terminal-capability-replies'

/**
 * #32242 / #39529: a live pane can end up with `options.theme` missing background
 * (createPaneDOM before applyTerminalAppearance, or value-gated theme writes that
 * preserve TUI OSC mutations). `terminalOscColorQueryReplies()` used to return null
 * and the handler answered nothing — TUIs that probe once at startup then pin dark.
 *
 * Intent: answer from the composed appearance fallback instead of silence.
 */

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

const WHITE = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
const DARK_FG = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'

describe('issue 32242 — OSC 10/11 must answer when the pane theme lost its slots', () => {
  it('answers an OSC 11 query (ST) when the pane theme has no background', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = { foreground: '#2e3434' }
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false,
      colorQueryFallback: () => ({ foreground: '#2e3434', background: '#ffffff' })
    })

    try {
      await writeTerminal(term, '\x1b]11;?\x1b\\')

      expect(sendInput).toHaveBeenCalledTimes(1)
      expect(sendInput).toHaveBeenCalledWith(WHITE)
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('answers an OSC 11 query with the BEL terminator too', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = { foreground: '#2e3434' }
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false,
      colorQueryFallback: () => ({ foreground: '#2e3434', background: '#ffffff' })
    })

    try {
      await writeTerminal(term, '\x1b]11;?\x07')

      expect(sendInput).toHaveBeenCalledWith(WHITE)
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('answers a combined 10;?;? query from the fallback when the theme has neither slot', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = {}
    const replies: string[] = []
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput: (data) => {
        replies.push(data)
      },
      isReplaying: () => false,
      colorQueryFallback: () => ({ foreground: '#2e3434', background: '#ffffff' })
    })

    try {
      await writeTerminal(term, '\x1b]10;?;?\x1b\\')

      expect(replies).toEqual([DARK_FG, WHITE])
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('prefers the live theme slot over the fallback', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = { background: '#112233' }
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false,
      colorQueryFallback: () => ({ foreground: '#2e3434', background: '#ffffff' })
    })

    try {
      await writeTerminal(term, '\x1b]11;?\x07')

      expect(sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/2222/3333\x1b\\')
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('stays silent while replaying a restored buffer', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = {}
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => true,
      colorQueryFallback: () => ({ foreground: '#2e3434', background: '#ffffff' })
    })

    try {
      await writeTerminal(term, '\x1b]11;?\x07')

      expect(sendInput).not.toHaveBeenCalled()
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })
})
