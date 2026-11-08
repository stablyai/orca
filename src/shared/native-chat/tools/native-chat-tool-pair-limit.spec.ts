import { describe, expect, it } from 'vitest'
import { pairToolBlocks } from './native-chat-tool-pairs'
import type { NativeChatBlock } from '../native-chat-types'

describe('tool pair limits', () => {
  it('gives a result that names its call to that call, past one that finished with no output', () => {
    const named = (name: string, callId: string): NativeChatBlock => ({
      type: 'tool-call',
      name,
      input: {},
      callId
    })
    const [spawn, wait, shell] = [
      named('spawn_agent', 's'),
      named('wait_agent', 'w'),
      named('Bash', 'x')
    ]
    const waited: NativeChatBlock = { type: 'tool-result', output: 'CHILD_REPLY', callId: 'w' }
    const ran: NativeChatBlock = { type: 'tool-result', output: 'CHILD_DONE', callId: 'x' }
    expect(pairToolBlocks([spawn, wait, waited, shell, ran])).toEqual([
      { call: spawn },
      { call: wait, result: waited },
      { call: shell, result: ran }
    ])
  })

  it('gives no retained call the output of a call past the limit', () => {
    const named = (callId: string): NativeChatBlock => ({
      type: 'tool-call',
      name: 'Bash',
      input: {},
      callId
    })
    const [spawn, shell, later] = [named('s'), named('x'), named('y')]
    const ran: NativeChatBlock = { type: 'tool-result', output: 'x', callId: 'x' }
    const laterRan: NativeChatBlock = { type: 'tool-result', output: 'y', callId: 'y' }
    expect(pairToolBlocks([spawn, shell, ran, later, laterRan], 2)).toEqual([
      { call: spawn },
      { call: shell, result: ran }
    ])
  })
})
