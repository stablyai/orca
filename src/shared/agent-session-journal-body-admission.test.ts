import { describe, expect, it } from 'vitest'
import {
  readAgentJournalItemBody,
  readAgentJournalMessageBody
} from './agent-session-journal-body-admission'

const RESOLUTION = { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
const QUESTION_ENTRY = {
  id: 'q-1',
  question: 'Which lane?',
  multiSelect: false,
  options: [{ id: 'o-1', label: 'First' }],
  freeTextQuestionId: 'q-1-other'
}
const QUESTION = {
  kind: 'question',
  question: 'Which lane?',
  options: [{ id: 'o-1', label: 'First' }],
  questions: [QUESTION_ENTRY],
  resolution: RESOLUTION
}
const PLAN_APPROVAL = {
  kind: 'approval',
  title: 'Approve the plan?',
  detail: null,
  options: [{ id: 'yes', label: 'Yes' }],
  resolution: RESOLUTION,
  subject: { kind: 'plan', text: 'Step one' }
}
const TURN_STATUS = {
  kind: 'status',
  text: 'Turn started',
  turnLifecycle: { turnId: 't-1', state: 'running', startedAt: 5 }
}
const GOAL = {
  objective: 'Ship it',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 1,
  timeUsedSeconds: 1,
  createdAt: 1,
  updatedAt: 1
}

describe('a body this build reads', () => {
  it.each([
    ['a question', QUESTION],
    ['a plan approval', PLAN_APPROVAL],
    ['a turn lifecycle', TURN_STATUS],
    ['a goal change', { kind: 'status', text: 'Goal', threadGoal: { state: 'set', goal: GOAL } }],
    [
      'a key it does not know, in a question and an option too',
      {
        ...QUESTION,
        next: 1,
        options: [{ id: 'o-1', label: 'First', shortcut: 'f' }],
        questions: [{ ...QUESTION_ENTRY, hint: 'Pick one' }]
      }
    ],
    [
      'a block type it does not know',
      { kind: 'message', role: 'assistant', blocks: [{ type: 'chart' }] }
    ],
    [
      'a goal state it does not know',
      { kind: 'status', text: 'Goal', threadGoal: { state: 'paused' } }
    ],
    ['a turn state it does not know', { kind: 'turn', turnId: 't', state: 'handed-off' }],
    ['a body kind it does not know', { kind: 'plan-card', steps: [{ text: 'by a newer build' }] }],
    [
      'a plan subject kind it does not know',
      { ...PLAN_APPROVAL, subject: { kind: 'diff', path: 'a.ts' } }
    ]
  ])('is readable: %s', (_name, body) => {
    expect(readAgentJournalItemBody(body)).toBe('readable')
  })
})

describe('anything else that fails: damage', () => {
  it.each([
    [
      "a turn's context usage of a kind it does not know, which the row reader drops first",
      { kind: 'turn', turnId: 't', state: 'done', contextUsage: { used: { kind: 'measured' } } }
    ],
    ['a body that is not an object', null],
    ['a body that is a list', [{ kind: 'status' }]],
    ['no kind', { text: 'x' }],
    ['an empty kind', { kind: '' }],
    ['a kind of only whitespace', { kind: '  ' }],
    ['a block type of only whitespace', { kind: 'message', role: 'user', blocks: [{ type: ' ' }] }],
    [
      'a plan subject kind of only whitespace',
      { ...PLAN_APPROVAL, subject: { kind: ' ', text: 'x' } }
    ],
    ['a kind that is not a string', { kind: 7 }],
    [
      'a nested literal that is not a string',
      { ...PLAN_APPROVAL, subject: { kind: 5, text: 'x' } }
    ],
    ['questions that are not a list', { ...QUESTION, questions: null }],
    [
      'a multi-select flag that is not a boolean',
      { ...QUESTION, questions: [{ ...QUESTION_ENTRY, multiSelect: 'yes' }] }
    ],
    [
      'a question option with no id',
      { ...QUESTION, questions: [{ ...QUESTION_ENTRY, options: [{ label: 'First' }] }] }
    ],
    ['a free-text question id that is not a string', { ...QUESTION, freeTextQuestionId: 4 }],
    ['a turn lifecycle with no turn', { ...TURN_STATUS, turnLifecycle: { state: 'running' } }],
    [
      'a turn lifecycle whose turn is a number',
      { ...TURN_STATUS, turnLifecycle: { turnId: 7, state: 'running' } }
    ],
    [
      'a goal with no token count',
      {
        kind: 'status',
        text: 'Goal',
        threadGoal: { state: 'set', goal: { ...GOAL, tokensUsed: null } }
      }
    ],
    ['a goal change with no goal', { kind: 'status', text: 'Goal', threadGoal: { state: 'set' } }],
    ['an empty plan', { ...PLAN_APPROVAL, subject: { kind: 'plan', text: '' } }],
    ['question options that are not a list', { ...QUESTION, options: null }],
    ['a question without its resolution', { ...QUESTION, resolution: undefined }],
    ['a diff whose patch is broken', { kind: 'diff', path: 'a.ts', patch: { head: 'x' } }],
    ['a turn with no state', { kind: 'turn', turnId: 't' }],
    ['a negative turn duration', { kind: 'turn', turnId: 't', state: 'done', durationMs: -1 }],
    ['a failure fact with no kind', { kind: 'status', text: 'Failed', failure: { kind: '' } }],
    [
      'a tool call id that is only spaces',
      { kind: 'tool-call', name: 'Read', state: 'done', callId: ' ' }
    ],
    [
      'a known block missing its text',
      { kind: 'message', role: 'user', blocks: [{ type: 'text' }] }
    ],
    ['a block type that is not a string', { kind: 'message', role: 'user', blocks: [{ type: 5 }] }]
  ])('is malformed: %s', (_name, body) => {
    expect(readAgentJournalItemBody(body)).toBe('malformed')
  })
})

describe("a submission's body", () => {
  it('reads a message, a newer kind as unreadable, and another known kind as damage', () => {
    expect(readAgentJournalMessageBody({ kind: 'message', role: 'user', blocks: [] })).toBe(
      'readable'
    )
    expect(readAgentJournalMessageBody({ kind: 'voice-note', clip: 'x' })).toBe('unreadable')
    expect(readAgentJournalMessageBody({ kind: ' ' })).toBe('malformed')
    expect(readAgentJournalMessageBody({ kind: 'status', text: 'x' })).toBe('malformed')
    expect(
      readAgentJournalMessageBody({ kind: 'message', role: 'user', blocks: [{ type: 'text' }] })
    ).toBe('malformed')
  })
})
