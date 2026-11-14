import { describe, expect, it } from 'vitest'
import type {
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../../../shared/native-chat/native-chat-types'
import { nativeChatSubagentEnding } from './native-chat-subagent-ending'

const said: NativeChatMessage = {
  id: 'r1',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Found two files.' }],
  timestamp: 1,
  source: 'transcript'
}

function entry(state: NativeChatSubagentEntry['state']): NativeChatSubagentEntry {
  return { id: 'a', label: 'List src', state, lastMessage: 'Permission denied for ls' }
}

describe('nativeChatSubagentEnding', () => {
  it('ends a completed subagent with its reply', () => {
    expect(
      nativeChatSubagentEnding({
        entry: entry('completed'),
        handoff: { prompt: null, reply: 'src holds math.ts', error: null },
        rows: [],
        history: 'landed'
      })
    ).toEqual({ kind: 'reply', text: 'src holds math.ts' })
  })

  it('never ends a failed subagent with a reply, only its error', () => {
    expect(
      nativeChatSubagentEnding({
        entry: entry('failed'),
        handoff: { prompt: null, reply: null, error: null },
        rows: [said],
        history: 'landed'
      })
    ).toEqual({ kind: 'error', text: 'Permission denied for ls' })
  })

  it('says a stopped subagent stopped before replying, whatever it said last', () => {
    expect(
      nativeChatSubagentEnding({
        entry: entry('stopped'),
        handoff: null,
        rows: [said],
        history: 'landed'
      })
    ).toEqual({ kind: 'aside', aside: 'stopped' })
  })

  it('adds no reply when its own last message already says it', () => {
    expect(
      nativeChatSubagentEnding({
        entry: { ...entry('completed'), lastMessage: 'Found two files.' },
        handoff: null,
        rows: [said],
        history: 'landed'
      })
    ).toBeNull()
  })
})
