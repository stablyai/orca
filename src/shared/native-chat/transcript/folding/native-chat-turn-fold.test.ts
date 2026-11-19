import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatTextBlock } from '../../native-chat-types'
import {
  nativeChatHistoryTurnFold,
  nativeChatTurnAnswerRows,
  nativeChatTurnFold,
  nativeChatTurnFoldRow
} from './native-chat-turn-fold'
import type { NativeChatResolvedPrompt } from '../../input/questions/native-chat-resolution-receipt'

function hookFailure(id: string, event: string): NativeChatMessage {
  return {
    id,
    role: 'system',
    timestamp: 1,
    source: 'transcript',
    blocks: [
      {
        type: 'text',
        text: `Codex ${event} hook failed: hook exited with code 1`,
        tone: 'error',
        providerFrame: {
          provider: 'codex',
          kind: 'notification:hook/completed',
          payload: { head: '{}', byteLength: 2, digest: 'fixture', truncated: false }
        }
      }
    ]
  }
}

const SETTLED = new Set(['turn-1'])
const NONE = new Set<string>()

function message(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  presentation?: NativeChatTextBlock['presentation']
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text, presentation }],
    timestamp: 1,
    source: 'transcript'
  }
}

const PROMPT = message('prompt', 'user', 'Propose the change.')
const PREAMBLE = message('preamble', 'assistant', 'I will inspect the files.')
const PLAN = message('plan', 'system', '# Proposed change', 'plan-document')
const ANSWER = message('answer', 'assistant', 'The final reply, completed after the checklist.')
const WORK: NativeChatMessage = {
  id: 'work',
  role: 'assistant',
  timestamp: 1,
  source: 'transcript',
  blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }]
}

describe('rendered plans in collapsed turns', () => {
  it.each([
    {
      name: 'native proposal after work',
      messages: [PROMPT, PREAMBLE, WORK, PLAN],
      folded: [2],
      answers: [1]
    },
    {
      name: 'named reply updated before a checklist row',
      messages: [PROMPT, ANSWER, PLAN],
      folded: [],
      answers: [1]
    },
    {
      name: 'checklist followed by a separate reply',
      messages: [PROMPT, PLAN, ANSWER],
      folded: [],
      answers: [2]
    },
    { name: 'plan as the only outcome', messages: [PROMPT, PLAN], folded: [], answers: [] },
    {
      name: 'plan before a hook sends the answer back',
      messages: [
        PROMPT,
        PREAMBLE,
        PLAN,
        message('hook', 'system', 'Continue the work.', 'hook-sent-back'),
        WORK,
        ANSWER
      ],
      folded: [4],
      answers: [1, 5]
    }
  ])('keeps the plan and existing answers visible: $name', ({ messages, folded, answers }) => {
    const rows = messages.map((item) => nativeChatTurnFoldRow(item, 'turn-1', undefined))
    const result = nativeChatTurnFold({ rows, settledTurnKeys: SETTLED, expandedTurnKeys: NONE })
    expect([...result.foldedRows]).toEqual(folded)
    expect([...nativeChatTurnAnswerRows(rows)]).toEqual(answers)
  })
})

describe('failed hooks in a settled turn', () => {
  it('keeps the answer and the hook failures after it visible, folding earlier ones as work', () => {
    const messages = [
      PROMPT,
      WORK,
      hookFailure('post-tool', 'PostToolUse'),
      ANSWER,
      hookFailure('post-model', 'PostModelRequest'),
      hookFailure('stop', 'Stop')
    ]
    const rows = messages.map((item) => nativeChatTurnFoldRow(item, 'turn-1', undefined))
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...foldedRows].sort()).toEqual([1, 2])
  })
})

it('retains only prepended history disclosures until an explicit collapse, while ordinary completion still folds', () => {
  const messages: NativeChatMessage[] = [PROMPT, WORK, ANSWER]
  const rows = messages.map((item) => nativeChatTurnFoldRow(item, 'turn-1', undefined))
  const initial = nativeChatHistoryTurnFold(null, {
    scope: 'a',
    messages: messages.slice(1),
    rows: rows.slice(1).map((r) => ({ ...r, turnKey: undefined })),
    expandedTurnKeys: NONE,
    settledTurnKeys: SETTLED
  })
  const input = { scope: 'a', messages, rows, expandedTurnKeys: NONE, settledTurnKeys: SETTLED }
  const retained = nativeChatHistoryTurnFold(initial, input)
  expect(retained.fold.foldedRows.size).toBe(0)
  expect(retained.expandedTurnKeys.has('turn-1')).toBe(true)
  expect(nativeChatHistoryTurnFold(retained, input).fold.foldedRows.size).toBe(0)
  const collapsed = nativeChatHistoryTurnFold(retained, { ...input, expandedTurnKeys: new Set() })
  expect([...collapsed.fold.foldedRows]).toEqual([1])
  expect([
    ...nativeChatHistoryTurnFold(retained, { ...input, scope: 'b' }).fold.foldedRows
  ]).toEqual([1])
  const running = nativeChatHistoryTurnFold(null, { ...input, settledTurnKeys: NONE })
  expect([...nativeChatHistoryTurnFold(running, input).fold.foldedRows]).toEqual([1])
})

describe('replies a settled turn keeps visible', () => {
  function answersAndFolded(
    messages: NativeChatMessage[],
    keys?: string[],
    receipts?: ReadonlyMap<string, NativeChatResolvedPrompt>
  ) {
    const rows = messages.map((item, index) =>
      nativeChatTurnFoldRow(item, keys?.[index] ?? 'turn-1', receipts?.get(item.id))
    )
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: new Set(keys ?? ['turn-1']),
      expandedTurnKeys: NONE
    })
    return {
      answers: [...nativeChatTurnAnswerRows(rows)].sort(),
      folded: [...foldedRows].sort()
    }
  }

  it('keeps the reply a steer interrupted, but not one before another agent’s message or a tool result', () => {
    const steer = message('steer', 'user', 'Also, which branch are you on?')
    const agentNote: NativeChatMessage = {
      ...message('note', 'user', 'Worker finished.'),
      from: { kind: 'agent', senders: [], orchestration: null }
    }
    const ack = message('ack', 'assistant', 'On main; continuing.')
    const orphanResult: NativeChatMessage = {
      ...message('orphan', 'user', ''),
      blocks: [{ type: 'tool-result', callId: 'gone', output: 'ok' }],
      unpairedToolResults: true
    }
    const messages = [PROMPT, PREAMBLE, WORK, steer, ack, agentNote, orphanResult, WORK, ANSWER]
    expect(answersAndFolded(messages)).toEqual({ answers: [1, 8], folded: [2, 4, 7] })
  })

  it('keeps the words that led to an answered question, whether its row holds the call or a receipt', () => {
    const report = message('report', 'assistant', '| Option | Cost |')
    const ask: NativeChatMessage = {
      ...WORK,
      id: 'ask',
      blocks: [
        { type: 'text', text: '| Option | Cost |' },
        { type: 'tool-call', name: 'AskUserQuestion', input: {}, state: 'completed' },
        ...WORK.blocks
      ]
    }
    expect(answersAndFolded([PROMPT, PREAMBLE, WORK, ask, WORK, ANSWER])).toEqual({
      answers: [3, 5],
      folded: [1, 2, 4]
    })
    const question = message('question', 'system', 'Which option?')
    const receipt: NativeChatResolvedPrompt = {
      kind: 'question',
      question: 'Which option?',
      options: [{ id: 'a', label: 'A' }],
      resolution: { state: 'resolved', selectedOptionId: 'a', resolvedBy: null, resolvedAt: 2 }
    }
    expect(
      answersAndFolded(
        [PROMPT, WORK, report, question, WORK, ANSWER],
        undefined,
        new Map([['question', receipt]])
      )
    ).toEqual({ answers: [2, 5], folded: [1, 3, 4] })
    expect(
      answersAndFolded(
        [PROMPT, PREAMBLE, WORK, question, WORK, ANSWER],
        undefined,
        new Map([['question', receipt]])
      )
    ).toEqual({ answers: [5], folded: [1, 2, 3, 4] })
  })

  it('keeps back-to-back replies, but not a reply its own row or an image operation follows', () => {
    const note = message('note', 'assistant', 'Checked the config.')
    const narration: NativeChatMessage = {
      ...WORK,
      id: 'narration',
      blocks: [{ type: 'text', text: 'I will run the tests.' }, ...WORK.blocks]
    }
    const messages = [PROMPT, note, PREAMBLE, WORK, narration, ANSWER]
    expect(answersAndFolded(messages)).toEqual({ answers: [1, 5], folded: [2, 3, 4] })
  })

  it.each([
    ['a generation whose preview moved into the answer', 'Generated image', 'generated-image'],
    ['an image view', 'Viewed image', 'image-operation']
  ] as const)('folds %s as work, not a reply', (_name, text, presentation) => {
    const operation = message('image', 'assistant', text, presentation)
    expect(answersAndFolded([PROMPT, PREAMBLE, operation, ANSWER])).toEqual({
      answers: [3],
      folded: [1, 2]
    })
  })

  it('judges back-to-back replies within their own turn when another turn’s rows interleave', () => {
    const { answers } = answersAndFolded(
      [PROMPT, PREAMBLE, WORK, ANSWER],
      ['turn-1', 'turn-1', 'turn-2', 'turn-1']
    )
    expect(answers).toEqual([1, 3])
  })
})
