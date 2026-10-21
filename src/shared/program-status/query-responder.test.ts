import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { installProgramStatusQueryResponder } from './query-responder'
import { PROGRAM_STATUS_QUERY_REPLY } from './protocol'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('installProgramStatusQueryResponder', () => {
  it('answers the query ahead of the DA1 sentinel that follows it', async () => {
    const terminal = new Terminal({ allowProposedApi: true })
    const replies: string[] = []
    terminal.onData((data) => replies.push(data))
    installProgramStatusQueryResponder({
      parser: terminal.parser,
      emitReply: (reply) => replies.push(reply)
    })
    await write(terminal, '\x1b]7501;?\x1b\\\x1b[c')
    expect(replies[0]).toBe(PROGRAM_STATUS_QUERY_REPLY)
    expect(replies[1].startsWith('\x1b[?')).toBe(true)
    terminal.dispose()
  })

  it('swallows reports without replying and stays silent while replaying', async () => {
    const terminal = new Terminal({ allowProposedApi: true })
    const replies: string[] = []
    installProgramStatusQueryResponder({
      parser: terminal.parser,
      emitReply: (reply) => replies.push(reply),
      shouldReply: () => false
    })
    await write(terminal, '\x1b]7501;state=working\x07\x1b]7501;?\x07')
    expect(replies).toEqual([])
    terminal.dispose()
  })
})
