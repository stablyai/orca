import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'

import { pairToolBlocks } from '../../../../../../shared/native-chat/tools/native-chat-tool-pairs'

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

it('preserves folded tools when an answer changes and another answer arrives', () => {
  const project = createNativeChatMessageListProjection()
  const prompt = message('prompt', 0, [{ type: 'text', text: 'Inspect' }], 'user')
  const lead = message('lead', 1, [{ type: 'text', text: 'Reading' }])
  const call = message(
    'call',
    2,
    [{ type: 'tool-call', name: 'Bash', callId: 'shell', input: { command: 'pwd' } }],
    'tool'
  )
  const result = message(
    'result',
    3,
    [{ type: 'tool-result', callId: 'shell', output: '/repo' }],
    'tool'
  )
  const answer = message('answer', 4, [{ type: 'text', text: 'Found' }])
  project([prompt, lead, call, result, answer])
  const revised = { ...answer, blocks: [{ type: 'text' as const, text: 'The answer grows' }] }
  const updated = project([prompt, lead, call, result, revised])
  expect(updated.conversation.map(({ id, blocks }) => ({ id, blocks }))).toEqual([
    { id: 'prompt', blocks: [{ type: 'text', text: 'Inspect' }] },
    {
      id: 'lead',
      blocks: [
        { type: 'text', text: 'Reading' },
        { type: 'tool-call', name: 'Bash', callId: 'shell', input: { command: 'pwd' } },
        { type: 'tool-result', callId: 'shell', output: '/repo' }
      ]
    },
    { id: 'answer', blocks: [{ type: 'text', text: 'The answer grows' }] }
  ])
  const appended = message('new-answer', 5, [{ type: 'text', text: 'Final answer' }])
  const extended = project([prompt, lead, call, result, revised, appended])
  expect(extended.conversation.map(({ id }) => id)).toEqual([
    'prompt',
    'lead',
    'answer',
    'new-answer'
  ])
  expect(extended.conversation.at(-1)?.blocks).toEqual([{ type: 'text', text: 'Final answer' }])
})

it('rebuilds when a tool append folds into the streaming assistant', () => {
  const project = createNativeChatMessageListProjection()
  const lead = message('lead', 1, [{ type: 'text', text: 'Working' }])
  const call = message(
    'call',
    2,
    [{ type: 'tool-call', name: 'Bash', callId: 'shell-1', input: { command: 'pwd' } }],
    'tool'
  )
  const result = message(
    'result',
    3,
    [{ type: 'tool-result', callId: 'shell-1', output: '/repo' }],
    'tool'
  )
  project([lead])
  const folded = project([lead, call, result])
  expect(folded.conversation).toHaveLength(1)
  expect(folded.conversation[0].blocks).toEqual([
    { type: 'text', text: 'Working' },
    { type: 'tool-call', name: 'Bash', callId: 'shell-1', input: { command: 'pwd' } },
    { type: 'tool-result', callId: 'shell-1', output: '/repo' }
  ])
  const revised = { ...lead, blocks: [{ type: 'text' as const, text: 'Finished' }] }
  expect(
    project([revised, call, result]).conversation.map(({ id, blocks }) => ({ id, blocks }))
  ).toEqual([
    {
      id: 'lead',
      blocks: [
        { type: 'text', text: 'Finished' },
        { type: 'tool-call', name: 'Bash', callId: 'shell-1', input: { command: 'pwd' } },
        { type: 'tool-result', callId: 'shell-1', output: '/repo' }
      ]
    }
  ])
})

it('revises the correct duplicate occurrence, including aliases settled to the same row', () => {
  const project = createNativeChatMessageListProjection()
  const tail = message('answer', 1, [{ type: 'text', text: 'Found' }])
  const alias = { ...tail, blocks: [...tail.blocks] }
  const revised = message('answer', 1, [{ type: 'text', text: 'Revised' }])
  const final = message('answer', 1, [{ type: 'text', text: 'Final' }])
  project([tail, tail])
  expect(project([revised, tail]).conversation.map(({ blocks }) => blocks)).toEqual([
    [{ type: 'text', text: 'Revised' }],
    [{ type: 'text', text: 'Found' }]
  ])
  expect(project([tail, alias]).conversation.map(({ blocks }) => blocks)).toEqual([
    [{ type: 'text', text: 'Found' }],
    [{ type: 'text', text: 'Found' }]
  ])
  expect(project([revised, final]).conversation.map(({ blocks }) => blocks)).toEqual([
    [{ type: 'text', text: 'Revised' }],
    [{ type: 'text', text: 'Final' }]
  ])
})

it('drops an empty lead after a same-output fallback changes its tool dependencies', () => {
  const project = createNativeChatMessageListProjection()
  const lead = message('lead', 1, [{ type: 'text', text: 'Reading' }])
  const result = message(
    'result',
    2,
    [{ type: 'tool-result', callId: 'missing', output: 'Orphan' }],
    'tool'
  )
  project([lead])
  project([lead, { ...result, unpairedToolResults: true }])
  project([lead, result])
  const empty = { ...lead, blocks: [] }
  expect(
    project([empty, result]).conversation.map(({ id, role, blocks, unpairedToolResults }) => ({
      id,
      role,
      blocks,
      unpairedToolResults
    }))
  ).toEqual([
    {
      id: 'result',
      role: 'tool',
      blocks: [{ type: 'tool-result', callId: 'missing', output: 'Orphan' }],
      unpairedToolResults: true
    }
  ])
  expect(
    project([message('lead', 1, [{ type: 'text', text: '' }]), result]).conversation.map(
      ({ id, blocks }) => ({ id, blocks })
    )
  ).toEqual([
    { id: 'lead', blocks: [{ type: 'text', text: '' }] },
    { id: 'result', blocks: [{ type: 'tool-result', callId: 'missing', output: 'Orphan' }] }
  ])
})

it('reallocates a detached result ID when a later raw message reserves it', () => {
  const project = createNativeChatMessageListProjection()
  const lead = {
    ...message('lead', 1, [
      { type: 'text', text: 'Reading' },
      { type: 'tool-result', callId: 'missing', output: 'Orphan' }
    ]),
    journalPosition: { sequence: 1, index: 0 }
  }
  project([lead])
  const appended = {
    ...message('unpaired-tool-results:["lead",0]', 2, [{ type: 'text', text: 'After' }]),
    journalPosition: { sequence: 2, index: 0 }
  }
  expect(
    project([lead, appended]).conversation.map(({ id, role, blocks }) => ({ id, role, blocks }))
  ).toEqual([
    { id: 'lead', role: 'assistant', blocks: [{ type: 'text', text: 'Reading' }] },
    {
      id: 'unpaired-tool-results:["lead",1]',
      role: 'tool',
      blocks: [{ type: 'tool-result', callId: 'missing', output: 'Orphan' }]
    },
    {
      id: 'unpaired-tool-results:["lead",0]',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'After' }]
    }
  ])
})
