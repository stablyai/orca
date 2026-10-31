import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { installTerminalCapabilityReplyHandlers } from './terminal-capability-replies'

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

const WHITE = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
const DARK_FG = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'
const fallback = () => ({ foreground: '#2e3434', background: '#ffffff' })

// #32242: createPaneDOM constructs a pane Terminal with no theme; applyTerminalAppearance
// runs later in a useEffect. Between mount and that first pass — and again later whenever
// options.theme legitimately loses a slot — terminalOscColorQueryReplies() returned null
// and the pane answered nothing at all, with no retry, so single-probe clients
// (opencode theme.mode=system) pinned dark for the whole session.
describe('OSC 10/11 must answer from the composed theme when the pane theme lost its slots (#32242)', () => {
  it('answers an OSC 11 query (ST) when the theme has no background', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = { foreground: '#2e3434' }
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false,
      colorQueryFallback: fallback
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
      colorQueryFallback: fallback
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
      colorQueryFallback: fallback
    })
    try {
      await writeTerminal(term, '\x1b]10;?;?\x1b\\')
      expect(replies).toEqual([DARK_FG, WHITE])
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('prefers the live theme slots over the fallback (TUI OSC mutations stay authoritative)', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = { foreground: '#2e3434', background: '#000000' }
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false,
      colorQueryFallback: fallback
    })
    try {
      await writeTerminal(term, '\x1b]11;?\x1b\\')
      expect(sendInput).toHaveBeenCalledWith('\x1b]11;rgb:0000/0000/0000\x1b\\')
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('still stays silent while replaying a restored buffer', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = {}
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => true,
      colorQueryFallback: fallback
    })
    try {
      await writeTerminal(term, '\x1b]11;?\x1b\\')
      expect(sendInput).not.toHaveBeenCalled()
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })
})
