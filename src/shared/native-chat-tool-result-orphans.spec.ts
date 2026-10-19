import { describe, expect, it } from 'vitest'
import { foldToolMessages, pairToolBlocks } from './native-chat-tool-fold'
import { nativeChatToolRunOutcome } from './native-chat-tool-run-outcome'
import { nativeChatWorkRunMember } from './native-chat-work-run'
import { nativeChatMessagesShareTranscriptRow } from './native-chat-types'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from './native-chat-types'

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

  it('keeps a leading named output visible and never matches it retroactively', () => {
    const old = row('old', 'tool', [result('x')])
    const once = foldToolMessages([old, row('x', 'assistant', [call('x')])])
    expect(once.map((message) => message.id)).toEqual(['old', 'x'])
    expect(pairToolBlocks(once[0]!.blocks)).toEqual([{ result: result('x') }])
    expect(pairToolBlocks(once[1]!.blocks)).toEqual([{ call: call('x') }])
    expect(foldToolMessages(once)).toEqual(once)
  })

  it('retains source ordering around activity and prose boundaries', () => {
    const roster: NativeChatBlock = { type: 'subagent-group', groupId: 'group', agents: [] }
    const input = [
      row('calls', 'assistant', [call('a')]),
      row('before', 'tool', [result('before')]),
      row('roster', 'system', [roster]),
      row('after', 'tool', [result('after'), result('a', 'A')]),
      row('prompt', 'user', [{ type: 'text', text: 'next prompt' }])
    ]
    const once = foldToolMessages(input)
    expect(once.map((message) => message.id)).toEqual([
      'calls',
      'before',
      'roster',
      'after',
      'prompt'
    ])
    expect(once[0]?.blocks).toEqual([call('a'), result('a', 'A')])
    expect(once[1]?.blocks).toEqual([result('before')])
    expect(once[3]?.blocks).toEqual([result('after')])
    expect(foldToolMessages(once)).toEqual(once)
  })

  it('uses distinct stable source IDs when both words and orphan results draw', () => {
    const source = row('source', 'assistant', [
      { type: 'text', text: 'kept prose' },
      call('a'),
      result('missing')
    ])
    const reserved = row('unpaired-tool-results:["source",0]', 'user', [
      { type: 'text', text: 'next' }
    ])
    const once = foldToolMessages([source, reserved])
    expect(once.map((message) => message.id)).toEqual([
      'source',
      'unpaired-tool-results:["source",1]',
      reserved.id
    ])
    expect(once[0]?.blocks).toEqual([{ type: 'text', text: 'kept prose' }, call('a')])
    expect(once[1]?.blocks).toEqual([result('missing')])
    expect(new Set(once.map((message) => message.id)).size).toBe(once.length)
    expect(foldToolMessages(once)).toEqual(once)
    expect(foldToolMessages([source, reserved])).toEqual(once)
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

  it('preserves result metadata while retaining historical anonymous orphan behavior', () => {
    const output: NativeChatToolResultBlock = {
      ...result('named'),
      isError: true,
      editPatch: {
        filePath: 'example.ts',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }]
      }
    }
    const once = foldToolMessages([row('outputs', 'tool', [result(undefined), output])])
    expect(once).toHaveLength(1)
    expect(once[0]).toMatchObject({ id: 'outputs', role: 'tool', blocks: [output] })
    expect(once[0]?.blocks[0]).toBe(output)
    expect(foldToolMessages([row('anonymous', 'tool', [result(undefined)])])).toEqual([])
  })
})
