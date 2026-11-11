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

it('preserves row content and child attribution through reordering, admission and retention', () => {
  const project = createNativeChatMessageListProjection()
  const parent = {
    ...message('prompt', 1, [{ type: 'text', text: 'Inspect' }], 'user'),
    journalPosition: { sequence: 1, index: 0 }
  }
  const tail = {
    ...message('answer', 2, [{ type: 'text', text: 'Found' }]),
    journalPosition: { sequence: 2, index: 0 }
  }
  const child = {
    ...message('child', 3, [{ type: 'text', text: 'Child answer' }]),
    agentId: 'child-a',
    journalPosition: { sequence: 3, index: 0 }
  }
  const pending: NativeChatMessage = {
    ...message('pending', 4, [{ type: 'text', text: 'Next' }], 'user'),
    pendingSend: 'active'
  }
  const inputs: NativeChatMessage[][] = [
    [parent, tail],
    [tail, parent],
    [parent, tail, pending],
    [
      parent,
      tail,
      { ...pending, pendingSend: undefined, journalPosition: { sequence: 4, index: 0 } }
    ],
    [parent, tail, child],
    [tail, child],
    [tail, { ...child, journalPosition: { sequence: 5, index: 0 } }],
    [tail, { ...tail, id: 'second', journalPosition: { sequence: 6, index: 0 } }],
    [tail, tail],
    [tail]
  ]
  const promptOutput = {
    id: 'prompt',
    role: 'user',
    blocks: [{ type: 'text', text: 'Inspect' }],
    pendingSend: undefined
  }
  const answerOutput = {
    id: 'answer',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Found' }],
    pendingSend: undefined
  }
  const pendingOutput = {
    id: 'pending',
    role: 'user',
    blocks: [{ type: 'text', text: 'Next' }],
    pendingSend: 'active'
  }
  const admittedOutput = {
    id: 'pending',
    role: 'user',
    blocks: [{ type: 'text', text: 'Next' }],
    pendingSend: undefined
  }
  const secondOutput = {
    id: 'second',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Found' }],
    pendingSend: undefined
  }
  const expected = [
    { conversation: [promptOutput, answerOutput], childTurn: null },
    { conversation: [promptOutput, answerOutput], childTurn: null },
    { conversation: [promptOutput, answerOutput, pendingOutput], childTurn: null },
    { conversation: [promptOutput, answerOutput, admittedOutput], childTurn: null },
    { conversation: [promptOutput, answerOutput], childTurn: 'prompt' },
    { conversation: [answerOutput], childTurn: undefined },
    { conversation: [answerOutput], childTurn: undefined },
    { conversation: [answerOutput, secondOutput], childTurn: null },
    { conversation: [answerOutput, answerOutput], childTurn: null },
    { conversation: [answerOutput], childTurn: null }
  ]
  for (const [index, rows] of inputs.entries()) {
    const result = project(rows)
    const output = expected[index]!
    expect(
      result.conversation.map(({ id, role, blocks, pendingSend }) => ({
        id,
        role,
        blocks,
        pendingSend
      }))
    ).toEqual(output.conversation)
    if (output.childTurn === null) {
      expect([...result.subagentRows]).toEqual([])
    } else {
      expect([...result.subagentRows.keys()]).toEqual(['child-a'])
      expect(result.subagentRows.get('child-a')).toMatchObject([
        {
          turnKey: output.childTurn,
          message: {
            id: 'child',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Child answer' }]
          }
        }
      ])
    }
  }
  const eligible = { ...tail, blocks: [{ type: 'text' as const, text: 'Eligible revision' }] }
  expect(project([eligible]).conversation.map(({ id, blocks }) => ({ id, blocks }))).toEqual([
    { id: 'answer', blocks: [{ type: 'text', text: 'Eligible revision' }] }
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
