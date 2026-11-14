import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatTextBlock } from '../native-chat-types'
import {
  nativeChatTurnAnswerRows,
  nativeChatTurnFold,
  nativeChatTurnFoldRow,
  type NativeChatTurnFoldRow
} from './native-chat-turn-fold'

function row(overrides: Partial<NativeChatTurnFoldRow> = {}): NativeChatTurnFoldRow {
  return {
    turnKey: 'turn-1',
    role: 'assistant',
    rendersProse: true,
    draws: true,
    outlivesTurn: false,
    reportsFailure: false,
    explainsTurn: false,
    endsAnswer: false,
    replyEnd: undefined,
    ...overrides
  }
}

/** An error-toned system row: the agent or host reporting the turn failed. */
const FAILURE = row({ role: 'system', reportsFailure: true })

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
    const rows = messages.map((item) => nativeChatTurnFoldRow(item, 'turn-1', false))
    const result = nativeChatTurnFold({ rows, settledTurnKeys: SETTLED, expandedTurnKeys: NONE })
    expect([...result.foldedRows]).toEqual(folded)
    expect([...nativeChatTurnAnswerRows(rows)]).toEqual(answers)
  })
})

describe('nativeChatTurnFold', () => {
  // A stored-only provider event draws nothing: a disclosure over it would open onto nothing.

  it('keeps a spawn roster or background task out of the fold', () => {
    const rows = [row({ role: 'user' }), row(), row({ outlivesTurn: true }), row()]
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect(foldedRows.has(2)).toBe(false)
    expect(foldedRows.has(1)).toBe(true)
  })

  it('folds each settled turn to its own answer and leaves a running turn alone', () => {
    const rows = [
      row({ turnKey: 'turn-1', role: 'user' }),
      row({ turnKey: 'turn-1', rendersProse: false }),
      row({ turnKey: 'turn-1' }),
      row({ turnKey: 'turn-2', role: 'user' }),
      row({ turnKey: 'turn-2', rendersProse: false }),
      row({ turnKey: 'turn-2' })
    ]
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: new Set(['turn-1']),
      expandedTurnKeys: NONE
    })
    expect([...foldedRows]).toEqual([1])
  })

  it('ends a failed turn on its error, folding the work and prose before it', () => {
    const rows = [row({ role: 'user' }), row(), row({ rendersProse: false }), FAILURE]
    const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...foldedRows].sort()).toEqual([1, 2])
    expect([...foldableTurnKeys]).toEqual(['turn-1'])
  })

  it('folds an error the agent recovered from behind the answer that followed it', () => {
    const rows = [row({ role: 'user' }), row({ rendersProse: false }), FAILURE, row()]
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...foldedRows].sort()).toEqual([1, 2])
  })

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
    const rows = messages.map((item) => nativeChatTurnFoldRow(item, 'turn-1', false))
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...nativeChatTurnAnswerRows(rows)]).toEqual([1, 8])
    expect([...foldedRows]).toEqual([2, 4, 7])
  })

  it('keeps back-to-back replies, but not a reply whose own row continues into work', () => {
    const NOTE = message('note', 'assistant', 'Checked the config.')
    const NARRATION: NativeChatMessage = {
      ...WORK,
      id: 'narration',
      blocks: [{ type: 'text', text: 'I will run the tests.' }, ...WORK.blocks]
    }
    const messages = [PROMPT, NOTE, PREAMBLE, WORK, NARRATION, ANSWER]
    const rows = messages.map((item) => nativeChatTurnFoldRow(item, 'turn-1', false))
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...nativeChatTurnAnswerRows(rows)]).toEqual([1, 5])
    expect([...foldedRows]).toEqual([2, 3, 4])
  })

  it('judges back-to-back replies within their own turn when another turn’s rows interleave', () => {
    const late = message('late', 'assistant', 'Other turn.')
    const messages = [PROMPT, PREAMBLE, late, ANSWER]
    const keys = ['turn-1', 'turn-1', 'turn-2', 'turn-1']
    const rows = messages.map((item, index) => nativeChatTurnFoldRow(item, keys[index], false))
    expect([...nativeChatTurnAnswerRows(rows)].sort()).toEqual([1, 2, 3])
  })

  it('never folds a compaction report, and keeps the last prose as the answer', () => {
    const rows = [
      row({ role: 'user' }),
      row(),
      row({ role: 'system', explainsTurn: true }),
      row(),
      row({ role: 'system', explainsTurn: true })
    ]
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...foldedRows]).toEqual([1])
    expect([...nativeChatTurnAnswerRows(rows)]).toEqual([3])
  })
})
