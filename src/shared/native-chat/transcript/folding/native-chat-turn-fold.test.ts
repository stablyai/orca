import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatTextBlock } from '../../native-chat-types'
import {
  nativeChatTurnAnswerRows,
  nativeChatTurnFold,
  nativeChatTurnFoldRow
} from './native-chat-turn-fold'

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
    const rows = messages.map((item) => nativeChatTurnFoldRow(item, 'turn-1', false))
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
    const rows = messages.map((item) => nativeChatTurnFoldRow(item, 'turn-1', false))
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...foldedRows].sort()).toEqual([1, 2])
  })
})
