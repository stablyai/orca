import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'

import { foldToolMessages } from '../../../../shared/native-chat/tools/native-chat-tool-fold'
import { pairToolBlocks } from '../../../../shared/native-chat/tools/native-chat-tool-pairs'

function message(
  id: string,
  timestamp: number,
  blocks: NativeChatMessage['blocks'],
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage {
  return { id, timestamp, blocks, role, source: 'transcript' }
}

it('retains detached evidence and its row identity when later work uses the same provider ID', () => {
  const project = createNativeChatMessageListProjection()
  const source = message('source', 1, [
    { type: 'text', text: 'Working' },
    { type: 'tool-call', name: 'Bash', callId: 'a', input: { command: 'echo a' } },
    { type: 'tool-result', callId: 'x', output: 'earlier unowned output' }
  ])
  const initial = project([source])
  const orphan = initial.conversation.find((row) => row.unpairedToolResults)
  expect(orphan).toBeDefined()
  expect(project([source])).toBe(initial)
  const laterCall = message(
    'later-call',
    2,
    [{ type: 'tool-call', name: 'Bash', callId: 'x', input: { command: 'echo x' } }],
    'tool'
  )
  const laterResult = message(
    'later-result',
    3,
    [{ type: 'tool-result', callId: 'x', output: 'actual later output' }],
    'tool'
  )
  const updated = project([source, laterCall, laterResult])
  expect(updated.conversation.find((row) => row.unpairedToolResults)).toBe(orphan)
  expect(updated.conversation[0]).not.toBe(initial.conversation[0])
  expect(pairToolBlocks(updated.conversation[0]!.blocks).at(-1)).toEqual({
    call: laterCall.blocks[0],
    result: laterResult.blocks[0]
  })
  expect(foldToolMessages(updated.conversation)).toEqual(updated.conversation)
  expect(source.blocks).toHaveLength(3)
})

// Reused blocks belong to producers; mutating them would freeze transcript output.
it('leaves producer-owned messages and blocks untouched', () => {
  const projectList = createNativeChatMessageListProjection()
  const project = (messages: NativeChatMessage[]) => projectList(messages).conversation
  const prose = message('prose', 1, [{ type: 'text', text: 'Working' }])
  const call = message('call', 2, [{ type: 'tool-call', name: 'shell', input: { command: 'pwd' } }])
  const result = message('result', 3, [{ type: 'tool-result', output: '/workspace' }], 'tool')
  const later = message(
    'later',
    4,
    [{ type: 'tool-call', name: 'read', input: { path: 'a.ts' } }],
    'tool'
  )
  const input = [prose, call, result, later]
  const snapshot = structuredClone(input)
  const folded = project(input)
  expect(folded[0]?.blocks).toHaveLength(4)
  expect(folded[0]?.blocks[0]).toBe(prose.blocks[0])
  project([...input, message('tail', 5, [{ type: 'text', text: 'Answer' }])])
  expect(input).toEqual(snapshot)
  expect(prose.blocks).toHaveLength(1)
})

// Parent streaming must retain the unchanged subagent map to avoid reordering it every frame.
it("keeps the subagent rows when only the conversation changes, and replaces them when a subagent's do", () => {
  const projectList = createNativeChatMessageListProjection()
  const child = (id: string, timestamp: number, text: string): NativeChatMessage => ({
    ...message(id, timestamp, [{ type: 'text', text }]),
    agentId: 'task-1'
  })
  const tail = message('tail', 3, [{ type: 'text', text: 'Answer' }])
  const rows = [child('child-1', 1, 'Reading'), child('child-2', 2, 'Found it'), tail]
  const initial = projectList(rows)

  const streamed = projectList([
    ...rows.slice(0, 2),
    { ...tail, blocks: [{ type: 'text', text: 'Answer grows' }] }
  ])
  expect(streamed.conversation).not.toBe(initial.conversation)
  expect(streamed.subagentRows).toBe(initial.subagentRows)

  const childSpoke = projectList([...rows, child('child-3', 4, 'Done')])
  expect(childSpoke.subagentRows).not.toBe(initial.subagentRows)
  expect(childSpoke.subagentRows.get('task-1')?.map((row) => row.message.id)).toEqual([
    'child-1',
    'child-2',
    'child-3'
  ])
})
