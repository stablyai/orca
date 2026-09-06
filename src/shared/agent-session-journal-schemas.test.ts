import { describe, expect, it } from 'vitest'
import {
  isAdmissibleAgentJournalItemBody,
  isAdmissibleAgentJournalMessageBody,
  isAdmissibleAgentJournalRenderItem,
  isAdmissibleAgentJournalSubmission
} from './agent-session-journal-schemas'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'

const PAYLOAD = { head: 'x', byteLength: 4, digest: 'd'.repeat(64), truncated: true }
const RESOLUTION = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

// Canonical fixtures are typed: if a shape here stops compiling, the schema
// audit below is validating the wrong model.
const CANONICAL_BODIES: AgentJournalItemBody[] = [
  {
    kind: 'message',
    role: 'user',
    blocks: [
      {
        type: 'text',
        text: 'hi',
        providerFrame: { provider: 'codex', kind: 'raw', payload: PAYLOAD }
      },
      { type: 'tool-call', name: 'Read', input: { path: 'a' } },
      { type: 'tool-result', output: 'ok', isError: false },
      { type: 'image-ref', path: '/tmp/a.png', alt: 'screenshot' },
      {
        type: 'subagent-group',
        groupId: 'claude-session:turn-1',
        agents: [
          { id: 'task-1', label: 'Explore', state: 'working', startedAt: 1_000 },
          { id: 'task-2', label: 'Review', state: 'completed', tokens: 42, settledAt: 2_000 }
        ]
      }
    ]
  },
  { kind: 'tool-call', name: 'Read', input: undefined, state: 'running' },
  { kind: 'tool-call', name: 'Read', input: {}, state: 'failed', output: PAYLOAD },
  { kind: 'diff', path: 'a.ts', patch: PAYLOAD },
  {
    kind: 'approval',
    title: 'Run?',
    detail: null,
    options: [{ id: 'a', label: 'Yes' }],
    resolution: RESOLUTION
  },
  {
    kind: 'question',
    question: 'Deploy?',
    options: [{ id: 'a', label: 'Yes' }],
    freeTextQuestionId: 'q-free',
    resolution: { state: 'resolved', selectedOptionId: 'a', resolvedBy: 'client', resolvedAt: 5 }
  },
  { kind: 'status', text: 'working' },
  {
    kind: 'status',
    text: 'turn',
    turnLifecycle: { turnId: 'turn-1', state: 'running' },
    providerFrame: { provider: 'codex', kind: 'raw', payload: PAYLOAD }
  }
]

describe('canonical admission', () => {
  it('admits every body shape this build writes', () => {
    for (const body of CANONICAL_BODIES) {
      expect(isAdmissibleAgentJournalItemBody(body)).toBe(true)
    }
  })

  it('admits a canonical render item and submission', () => {
    const item: AgentJournalRenderItem = {
      itemId: 'codex:t:turn:0',
      revision: 1,
      body: CANONICAL_BODIES[0] as AgentJournalItemBody,
      sequence: 1,
      observedAt: 1_000,
      recovered: true
    }
    expect(isAdmissibleAgentJournalRenderItem(item)).toBe(true)
    const submission: AgentJournalSubmission = {
      clientMessageId: 'm-1',
      fence: 1,
      payloadFingerprint: 'a'.repeat(64),
      dispatchState: 'unknown',
      providerItemId: null,
      reason: null,
      submittedAt: 1_000,
      resolvedAt: null
    }
    expect(isAdmissibleAgentJournalSubmission(submission)).toBe(true)
  })
})

describe('nested corruption is rejected', () => {
  it('rejects prompt bodies whose options or resolution cannot be rendered', () => {
    expect(
      isAdmissibleAgentJournalItemBody({
        kind: 'question',
        question: 'Deploy?',
        options: null,
        resolution: { state: 'resolved', selectedOptionId: 'a', resolvedBy: 'c', resolvedAt: 1 }
      })
    ).toBe(false)
    expect(
      isAdmissibleAgentJournalItemBody({
        kind: 'question',
        question: 'Deploy?',
        options: [],
        resolution: null
      })
    ).toBe(false)
    expect(
      isAdmissibleAgentJournalItemBody({
        kind: 'approval',
        title: 'Run?',
        detail: null,
        options: [{ id: 'a' }],
        resolution: RESOLUTION
      })
    ).toBe(false)
  })

  it('rejects broken payload, lifecycle, and block shapes', () => {
    expect(
      isAdmissibleAgentJournalItemBody({ kind: 'diff', path: 'a.ts', patch: { head: 'x' } })
    ).toBe(false)
    expect(
      isAdmissibleAgentJournalItemBody({ kind: 'status', text: 'x', turnLifecycle: true })
    ).toBe(false)
    // A KNOWN block type with a broken payload must not slip through as a
    // "future" block.
    expect(
      isAdmissibleAgentJournalItemBody({
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: null }]
      })
    ).toBe(false)
    expect(
      isAdmissibleAgentJournalItemBody({ kind: 'message', role: 'user', blocks: 'not-blocks' })
    ).toBe(false)
  })

  it('rejects a subagent roster whose entries are malformed', () => {
    // A KNOWN block type stays a known block: it must not fall through to the
    // forward-tolerant arm just because its payload is wrong.
    expect(
      isAdmissibleAgentJournalItemBody({
        kind: 'message',
        role: 'system',
        blocks: [{ type: 'subagent-group', groupId: 'g', agents: [{ id: 'a', label: 'x' }] }]
      })
    ).toBe(false)
    expect(
      isAdmissibleAgentJournalItemBody({
        kind: 'message',
        role: 'system',
        blocks: [{ type: 'subagent-group', groupId: 'g', agents: 'not-a-roster' }]
      })
    ).toBe(false)
  })

  it('keeps a state string a newer build might write admissible', () => {
    expect(
      isAdmissibleAgentJournalItemBody({
        kind: 'message',
        role: 'system',
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'g',
            agents: [{ id: 'a', label: 'x', state: 'some-future-state' }]
          }
        ]
      })
    ).toBe(true)
  })

  it('rejects shallow render items and submissions', () => {
    expect(
      isAdmissibleAgentJournalRenderItem({
        itemId: 'i-1',
        revision: 1,
        body: { kind: 'status', text: 'x' }
      })
    ).toBe(false)
    expect(isAdmissibleAgentJournalSubmission({ clientMessageId: 'm-1' })).toBe(false)
  })

  it('only admits message bodies for submissions', () => {
    expect(isAdmissibleAgentJournalMessageBody({ kind: 'status', text: 'x' })).toBe(false)
    expect(isAdmissibleAgentJournalMessageBody({ kind: 'message', role: 'user', blocks: [] })).toBe(
      true
    )
  })
})

describe('forward tolerance', () => {
  it('keeps unknown block types, wider state strings, and extra keys admissible', () => {
    expect(
      isAdmissibleAgentJournalItemBody({
        kind: 'message',
        role: 'narrator',
        blocks: [{ type: 'future-block', data: 1 }],
        futureField: 'ignored'
      })
    ).toBe(true)
    expect(
      isAdmissibleAgentJournalItemBody({ kind: 'tool-call', name: 'Read', state: 'paused' })
    ).toBe(true)
    expect(
      isAdmissibleAgentJournalSubmission({
        clientMessageId: 'm-1',
        fence: 1,
        payloadFingerprint: 'a'.repeat(64),
        dispatchState: 'some-future-state',
        providerItemId: null,
        reason: null,
        submittedAt: 1_000,
        resolvedAt: null
      })
    ).toBe(true)
  })
})
