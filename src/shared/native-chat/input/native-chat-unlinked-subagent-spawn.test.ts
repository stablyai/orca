import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from '../native-chat-types'
import { projectNativeChatTranscript } from '../transcript/native-chat-transcript-projection'
import {
  frameNativeChatSubagentTranscript,
  nativeChatSpawnedSubagentId
} from './native-chat-subagent-brief'
import { linkUnrecordedSubagentSpawns } from './native-chat-unlinked-subagent-spawn'

const THREAD = '01a19905-3734-7941-9a1b-e256ccbdb54d'

function text(message: NativeChatMessage): string {
  return message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function message(
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatBlock[]
): NativeChatMessage {
  return { id, role, blocks, timestamp: null, source: 'transcript' }
}

describe('unrecorded subagent spawns', () => {
  it('adds a title-only spawn card for a roster child and frames that title above the result', () => {
    const roster = message('roster', 'system', [
      {
        type: 'subagent-group',
        groupId: 'turn-1',
        agents: [{ id: THREAD, label: 'sample_greeting', state: 'completed' }]
      }
    ])
    const linked = linkUnrecordedSubagentSpawns([roster])
    const call = linked[0]?.blocks.find((block) => block.type === 'tool-call')
    const result = linked[0]?.blocks.find((block) => block.type === 'tool-result')
    expect(call).toMatchObject({
      name: 'spawn_agent',
      input: { task_name: 'sample_greeting' }
    })
    expect(result && result.type === 'tool-result' ? result.output : 'sealed').toBe('')
    expect(
      nativeChatSpawnedSubagentId(
        'spawn_agent',
        result?.type === 'tool-result' ? result : undefined
      )
    ).toBe(THREAD)
    const projected = projectNativeChatTranscript([roster])
    expect(
      projected.conversation[0]?.blocks.some(
        (block) => block.type === 'tool-call' && block.name === 'spawn_agent'
      )
    ).toBe(true)
    expect(linkUnrecordedSubagentSpawns(linked)).toBe(linked)

    const framed = frameNativeChatSubagentTranscript(
      THREAD,
      [
        message('agents', 'user', [{ type: 'text', text: '# AGENTS\nFollow the repo rules.' }]),
        message('end', 'assistant', [{ type: 'text', text: 'Hello from Orca scratch.' }])
      ],
      linked,
      { title: 'sample_greeting', prompt: 'Hello from Orca scratch.' }
    )
    expect(text(framed[0]!)).toBe('sample_greeting')
    expect(text(framed.at(-1)!)).toBe('Hello from Orca scratch.')
    expect(framed.some((entry) => text(entry).includes('gAAAAA'))).toBe(false)
  })

  it('leaves an Agent card that already names the child as the only spawn', () => {
    const parent = message('spawn', 'assistant', [
      {
        type: 'tool-call',
        name: 'Agent',
        callId: 'toolu_1',
        input: { description: 'Say hello', prompt: 'Reply with hello' }
      },
      {
        type: 'tool-result',
        callId: 'toolu_1',
        output: 'async agent launched',
        subagent: { id: 'child-1', state: 'completed' }
      },
      {
        type: 'subagent-group',
        groupId: 'turn-1',
        agents: [{ id: 'child-1', label: 'Say hello', state: 'completed' }]
      }
    ])
    const linked = linkUnrecordedSubagentSpawns([parent])
    expect(linked).toEqual([parent])
    expect(
      linked[0]?.blocks.filter((block) => block.type === 'tool-call').map((block) => block.name)
    ).toEqual(['Agent'])
  })
})
