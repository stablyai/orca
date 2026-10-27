import { describe, expect, it } from 'vitest'
import { pairToolBlocks } from './native-chat-tool-pairs'
import type { NativeChatBlock } from '../../native-chat-types'

const call: NativeChatBlock = { type: 'tool-call', name: 'read', input: {} }
const result: NativeChatBlock = { type: 'tool-result', output: 'done' }

describe('tool pair limits', () => {
  it('stops visiting blocks once retained pairs are fully answered', () => {
    let reads = 0
    const tail = Array.from({ length: 10000 }, () => ({
      get type() {
        reads++
        return 'tool-call' as const
      },
      name: 'read',
      input: {}
    }))
    expect(pairToolBlocks([call, result, ...tail], 1)).toEqual([{ call, result }])
    expect(reads).toBe(0)
  })

  it('still answers every retained call when the results trail far behind', () => {
    // Retain scanning until every retained call is answered, or mobile would spin on completed tools.
    const blocks = [call, call, ...Array.from({ length: 5000 }, () => result)]
    expect(pairToolBlocks(blocks, 2)).toEqual([
      { call, result },
      { call, result }
    ])
  })

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

  it('keeps a leading stray result and then stops at the limit', () => {
    const blocks = [result, call, result, call, result]
    expect(pairToolBlocks(blocks, 1)).toEqual([{ result }])
  })
})
