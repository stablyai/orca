import { describe, expect, it } from 'vitest'
import { foldToolMessages } from './native-chat-tool-fold'
import { pairToolBlocks } from './native-chat-tool-pairs'
import { nativeChatToolRunOutcome } from './native-chat-tool-run-outcome'
import { nativeChatWorkRunMember } from '../native-chat-work-run'
import { nativeChatMessagesShareTranscriptRow } from '../native-chat-types'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../native-chat-types'

function row(
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatBlock[]
): NativeChatMessage {
  return { id, role, blocks, timestamp: 1, source: 'transcript' }
}

function call(callId: string): NativeChatToolCallBlock {
  return { type: 'tool-call', name: 'Bash', callId, input: { command: callId } }
}

function result(
  callId: string | undefined,
  output = callId ?? 'anonymous'
): NativeChatToolResultBlock {
  return { type: 'tool-result', ...(callId === undefined ? {} : { callId }), output }
}

describe('unmatched named tool outputs', () => {
  it('never authorizes an earlier result after a later call is folded or the rows are folded twice', () => {
    const old = result('x', 'OLD X')
    const input = [
      row('a', 'assistant', [call('a')]),
      row('old', 'tool', [old]),
      row('x', 'assistant', [call('x')])
    ]
    const once = foldToolMessages(input)
    expect(once.map((message) => message.id)).toEqual(['a', 'old'])
    expect(pairToolBlocks(once[0]!.blocks)).toEqual([{ call: call('a') }, { call: call('x') }])
    expect(once[1]).toMatchObject({ id: 'old', role: 'tool', blocks: [old] })
    expect(foldToolMessages(once)).toEqual(once)
    const roundTrip: NativeChatMessage[] = JSON.parse(JSON.stringify(once))
    expect(foldToolMessages(roundTrip)).toEqual(once)
    expect(input.map((message) => message.blocks)).toEqual([[call('a')], [old], [call('x')]])
  })

  it('retains harness sidecar text and independently attributed results with source cursors', () => {
    const assistant = row('a', 'assistant', [call('a')])
    assistant.journalPosition = { sequence: 1, index: 0 }
    const harness = row('harness', 'user', [
      result('missing'),
      { type: 'text', text: '<system-reminder>Keep going.</system-reminder>' },
      result('a', 'A')
    ])
    harness.journalPosition = { sequence: 3, index: 0 }
    harness.transcriptOffset = 90
    const once = foldToolMessages([assistant, harness])
    expect(once).toHaveLength(3)
    expect(once[0]).toMatchObject({
      id: 'a',
      blocks: [call('a'), result('a', 'A')],
      foldedJournalPosition: harness.journalPosition
    })
    expect(once[1]).toMatchObject({
      role: 'tool',
      blocks: [result('missing')],
      journalPosition: harness.journalPosition,
      transcriptOffset: 90
    })
    expect(once[2]).toMatchObject({ id: 'harness', role: 'user', blocks: [harness.blocks[1]] })
    expect(nativeChatMessagesShareTranscriptRow(once[1]!, once[2]!)).toBe(true)
    expect(foldToolMessages(once)).toEqual(once)
  })

  it('keeps orphan errors outside owned call outcomes and work runs', () => {
    const error = { ...result('missing'), isError: true }
    const once = foldToolMessages([row('a', 'assistant', [call('a'), result('a', 'OK'), error])])
    expect(nativeChatToolRunOutcome(once[0]!.blocks, {})).toMatchObject({
      failedCallCount: 0,
      succeeded: true
    })
    expect(once[1]?.blocks).toEqual([error])
    expect(nativeChatWorkRunMember(once[1]!, false, false)).toBeNull()
  })
})
