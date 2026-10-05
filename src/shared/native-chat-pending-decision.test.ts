import { describe, expect, it } from 'vitest'
import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from './agent-session-journal-types'
import {
  resolveStructuredSessionDecision,
  resolveTerminalChatDecision
} from './native-chat-pending-decision'
import type { NativeChatAsyncQuestionsView } from './native-chat-async-questions'
import type { NativeChatMessage } from './native-chat-types'

const ABSENT: NativeChatAsyncQuestionsView = { state: 'absent' }
const askA = JSON.stringify({ questions: [{ question: 'A?', options: [{ label: 'x' }] }] })
const approval = JSON.stringify({ approval: { tool: 'ExitPlanMode', summary: '1. step' } })
const unknownArm = JSON.stringify({ choice: { title: 'Implement this plan?' } })

function transcriptAsk(question: string): NativeChatMessage[] {
  return [
    {
      id: 'call',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks: [
        {
          type: 'tool-call',
          name: 'AskUserQuestion',
          input: { questions: [{ question, options: [{ label: 'y' }] }] }
        }
      ]
    }
  ]
}

function resolve(
  status: { state?: string; interactivePrompt?: string; toolName?: string } | null,
  messages: NativeChatMessage[] = [],
  asyncQuestions: NativeChatAsyncQuestionsView = ABSENT,
  transcriptSettled = true
) {
  return resolveTerminalChatDecision({ status, messages, transcriptSettled, asyncQuestions })
}

describe('resolveTerminalChatDecision', () => {
  it('shows an approval or unsupported envelope only while paused (STA-3144)', () => {
    expect(resolve({ state: 'waiting', interactivePrompt: approval }).decision).toMatchObject({
      kind: 'approval',
      tool: 'ExitPlanMode'
    })
    expect(resolve({ state: 'working', interactivePrompt: approval }).decision).toBeNull()
    expect(resolve({ state: 'blocked', interactivePrompt: unknownArm }).decision).toEqual({
      kind: 'unsupported',
      text: 'Implement this plan?'
    })
    expect(resolve({ state: 'done', interactivePrompt: unknownArm }).decision).toBeNull()
  })

  it('ranks the envelope over a transcript question', () => {
    expect(
      resolve({ state: 'waiting', interactivePrompt: approval }, transcriptAsk('B?')).decision?.kind
    ).toBe('approval')
  })

  it('hides a sticky status ask once the agent moved on but keeps it as the dismissal identity', () => {
    const result = resolve({
      state: 'working',
      interactivePrompt: askA,
      toolName: 'AskUserQuestion'
    })
    expect(result.decision).toBeNull()
    expect(result.detectedAsk?.questions[0]?.question).toBe('A?')
  })

  it('does not fall back to a transcript ask while a status ask exists', () => {
    const result = resolve(
      { state: 'working', interactivePrompt: askA, toolName: 'AskUserQuestion' },
      transcriptAsk('B?')
    )
    expect(result.decision).toBeNull()
    expect(result.detectedAsk?.questions[0]?.question).toBe('A?')
  })

  it('shows a pending transcript ask with no live status, once the read settled', () => {
    expect(resolve(null, transcriptAsk('B?')).decision).toMatchObject({ kind: 'question' })
    expect(resolve(null, transcriptAsk('B?'), ABSENT, false).decision).toBeNull()
  })

  it('suppresses heuristics for an unsupported envelope with numbered plan prose', () => {
    expect(resolve({ state: 'blocked', interactivePrompt: unknownArm }).heuristicsAllowed).toBe(
      false
    )
  })

  it('allows heuristics only when paused, envelope-free, ask-free and async-free', () => {
    expect(resolve({ state: 'blocked' }).heuristicsAllowed).toBe(true)
    expect(resolve({ state: 'working' }).heuristicsAllowed).toBe(false)
    expect(resolve({ state: 'blocked' }, transcriptAsk('B?')).heuristicsAllowed).toBe(false)
    const question = { key: 'k', index: 0, title: 'Which color would you like to use?' }
    expect(
      resolve({ state: 'blocked' }, [], { state: 'ready', questions: [question] }).heuristicsAllowed
    ).toBe(false)
    expect(resolve({ state: 'blocked' }, [], { state: 'pending' }).heuristicsAllowed).toBe(false)
    expect(
      resolve({ state: 'blocked' }, [], { state: 'ready', questions: [] }).heuristicsAllowed
    ).toBe(true)
  })
})

type PromptItem = AgentJournalRenderItem & {
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
}

const resolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

function approvalItem(itemId: string, subject?: unknown): PromptItem {
  const body: AgentJournalApprovalItem = {
    kind: 'approval',
    title: 'Approve plan?',
    detail: null,
    options: [{ id: 'yes', label: 'Yes' }],
    resolution
  }
  return {
    itemId,
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: subject === undefined ? body : Object.assign(body, { subject })
  }
}

function questionItem(itemId: string): PromptItem {
  return {
    itemId,
    revision: 1,
    sequence: 2,
    observedAt: 2,
    body: { kind: 'question', question: 'Q?', options: [], resolution }
  }
}

describe('resolveStructuredSessionDecision', () => {
  it('takes the first pending item in journal order', () => {
    expect(resolveStructuredSessionDecision([questionItem('q'), approvalItem('a')])?.kind).toBe(
      'question'
    )
    expect(resolveStructuredSessionDecision([approvalItem('a'), questionItem('q')])?.kind).toBe(
      'approval'
    )
    expect(resolveStructuredSessionDecision([])).toBeNull()
  })

  it('reads an unknown subject kind as unsupported with no options', () => {
    const decision = resolveStructuredSessionDecision([
      approvalItem('a', { kind: 'future-subject', text: 'x' })
    ])
    expect(decision).toMatchObject({ kind: 'unsupported', text: 'Approve plan?' })
  })

  it('keeps a known plan subject approvable', () => {
    expect(
      resolveStructuredSessionDecision([approvalItem('a', { kind: 'plan', text: '1. step' })])?.kind
    ).toBe('approval')
  })
})
