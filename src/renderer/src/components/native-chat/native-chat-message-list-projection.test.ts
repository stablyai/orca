import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'

import { projectNativeChatTranscript } from '../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { compareMessages, orderMessages } from './native-chat-session-assembler'

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

// A streaming prose revision must not revisit settled tools, regardless of browsed history size.
it.each([1000, 10000])(
  'reuses stable folds for a text revision and append with %i raw rows',
  (size) => {
    let settledBlockReads = 0
    const rows = Array.from({ length: size }, (_, index) => {
      const part = index % 10
      const row = message(
        `row-${index}`,
        index,
        part > 1 && part < 9
          ? [
              {
                type: 'tool-call',
                name: 'Bash',
                callId: `call-${index}`,
                input: { command: 'pwd' }
              }
            ]
          : [{ type: 'text', text: part === 0 ? 'Inspect the file' : 'Reading the file' }],
        part === 0 ? 'user' : part > 1 && part < 9 ? 'tool' : 'assistant'
      )
      row.journalPosition = { sequence: index + 1, index: 0 }
      if (part === 1) {
        const blocks = row.blocks
        Object.defineProperty(row, 'blocks', {
          enumerable: true,
          get() {
            settledBlockReads++
            return blocks
          }
        })
      }
      return row
    })
    const project = createNativeChatMessageListProjection()
    const initial = project(rows)
    settledBlockReads = 0
    const tail = rows.at(-1)!
    const revised = {
      ...tail,
      timestamp: size + 100,
      journalPosition: { sequence: size, index: 0 },
      blocks: [{ type: 'text' as const, text: 'The answer grows' }]
    }
    const revisedRows = [...rows.slice(0, -1), revised]
    const updated = project(revisedRows)
    expect(settledBlockReads).toBe(0)
    expect(updated.conversation[1]).toBe(initial.conversation[1])
    expect(updated.conversation[1].blocks).toHaveLength(8)
    expect(updated.conversation.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'The answer grows' }
    ])
    expect(updated).toEqual(
      projectNativeChatTranscript(revisedRows, compareMessages, null, orderMessages)
    )
    const appended = {
      ...message('new-answer', size + 101, [{ type: 'text', text: 'Final answer' }]),
      journalPosition: { sequence: size + 1, index: 0 }
    }
    settledBlockReads = 0
    const extended = project([...revisedRows, appended])
    expect(settledBlockReads).toBe(0)
    expect(extended.conversation.at(-1)).toBe(appended)
    expect(extended).toEqual(
      projectNativeChatTranscript([...revisedRows, appended], compareMessages, null, orderMessages)
    )
  }
)

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
  expect(project([revised, call, result])).toEqual(
    projectNativeChatTranscript([revised, call, result], compareMessages, null, orderMessages)
  )
})

it('matches full projection through order, retention, optimistic admission and child turn changes', () => {
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
  for (const rows of inputs) {
    expect(project(rows)).toEqual(
      projectNativeChatTranscript(rows, compareMessages, null, orderMessages)
    )
  }
})

it.each([100, 1000])(
  'adds no raw-history admission scan while child output forces a full fold (%i rows)',
  (size) => {
    const rows = Array.from({ length: size }, (_, index) => ({
      ...message(
        `row-${index}`,
        index,
        [{ type: 'text' as const, text: 'settled' }],
        index % 2 ? 'assistant' : 'user'
      ),
      journalPosition: { sequence: index + 1, index: 0 }
    }))
    const child = {
      ...message('child', size, [{ type: 'text' as const, text: 'child' }]),
      agentId: 'child'
    }
    const project = createNativeChatMessageListProjection()
    project([...rows, child])
    for (let revision = 0; revision < 3; revision++) {
      const updated = [
        ...rows.slice(0, -1),
        { ...rows.at(-1)!, blocks: [{ type: 'text' as const, text: `reply-${revision}` }] },
        child
      ]
      let reads = 0
      const input = new Proxy(updated, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            reads++
          }
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Preserve every array read and its receiver while counting numeric reads in this perf contract.
          return Reflect.get(target, key, receiver)
        }
      })
      const oracle = projectNativeChatTranscript(input, compareMessages, null, orderMessages)
      const requiredReads = reads
      reads = 0
      const result = project(input)
      expect(reads).toBeLessThanOrEqual(requiredReads)
      expect(result).toEqual(oracle)
    }
    expect(project(rows)).toEqual(
      projectNativeChatTranscript(rows, compareMessages, null, orderMessages)
    )
    let stableReads = 0
    const lead = rows[0]!
    const blocks = lead.blocks
    Object.defineProperty(lead, 'blocks', {
      enumerable: true,
      get() {
        stableReads++
        return blocks
      }
    })
    const revised = [
      ...rows.slice(0, -1),
      { ...rows.at(-1)!, blocks: [{ type: 'text' as const, text: 'eligible revision' }] }
    ]
    const result = project(revised)
    expect(stableReads).toBe(0)
    expect(result).toEqual(
      projectNativeChatTranscript(revised, compareMessages, null, orderMessages)
    )
  }
)
