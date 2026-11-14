import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { installTerminalCapabilityReplyHandlers } from './terminal-capability-replies'

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

describe('installTerminalCapabilityReplyHandlers', () => {
  it.each([
    ['OSC 11 then CPR', '\x1b]11;?\x1b\\\x1b[6n', ['osc', 'cpr']],
    ['CPR then OSC 11', '\x1b[6n\x1b]11;?\x1b\\', ['cpr', 'osc']]
  ] as const)('preserves combined query order (%s)', async (_name, input, expectedKinds) => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = { background: '#ffffff' }
    const replies: string[] = []
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput: (data) => {
        replies.push(data)
      },
      isReplaying: () => false
    })
    const onData = term.onData((data) => replies.push(data))

    try {
      await writeTerminal(term, input)
      const kinds = replies.map((reply) => (reply.startsWith('\x1b]11;') ? 'osc' : 'cpr'))
      expect(kinds).toEqual(expectedKinds)
    } finally {
      onData.dispose()
      disposable.dispose()
      term.dispose()
    }
  })
})
