import { describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkInput } from './agent-status-child-work'
import { createAgentChildWorkAdmission } from './agent-status-child-work-admission'
import {
  parseAgentChildWorkInput,
  parseAgentChildWorkRecord
} from './agent-status-child-work-codec'
import { createAgentStatusStore } from './agent-status-store'
import { makeStructuredAgentStatusSubject } from './agent-status-subject'

const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'folder-1',
    workspaceKind: 'folder'
  },
  'session_11111111-1111-4111-8111-111111111111'
)

const OPERATION = { toolName: 'Bash', input: 'npm test', basis: 'open', observedAt: 15 } as const

function live(overrides: Partial<AgentChildWorkInput> = {}): AgentChildWorkInput {
  return {
    childWorkId: 'child-1',
    parent,
    provider: 'claude',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 10,
    observedAt: 20,
    stoppable: true,
    invocation: { invocationId: 'invocation-1', generation: 1 },
    provenance: { source: 'structured-session', producerId: 'journal-1' },
    ...overrides
  }
}

function settled(overrides: Partial<AgentChildWorkInput> = {}): AgentChildWorkInput {
  return live({
    state: 'done',
    membership: 'settled',
    outcome: 'succeeded',
    settledAt: 18,
    ...overrides
  })
}

// Literal matrix, not re-derived from the implementation: each cell names why it is illegal.
const ILLEGAL: [string, AgentChildWorkInput][] = [
  ['live work that says it is done', live({ state: 'done' })],
  ['live work with an outcome', live({ outcome: 'succeeded' })],
  ['live work with an unknown outcome', live({ outcome: 'unknown' })],
  ['live work with a settle time', live({ settledAt: 15 })],
  ['an agent storing monitoring', live({ state: 'monitoring' })],
  ['a workflow storing monitoring', live({ kind: 'workflow', state: 'monitoring' })],
  ['an unknown kind storing monitoring', live({ kind: 'unknown', state: 'monitoring' })],
  ['settled work still working', settled({ state: 'working' })],
  ['settled work monitoring', settled({ kind: 'command', state: 'monitoring' })],
  ['settled work waiting', settled({ state: 'waiting' })],
  ['settled work blocked', settled({ state: 'blocked' })],
  ['settled work idle', settled({ state: 'idle' })],
  ['settled work unverifiable', settled({ state: 'unverifiable' })],
  ['settled before it was first seen', settled({ settledAt: 9 })],
  ['settled after its newest evidence', settled({ settledAt: 21 })],
  ['settled work with an operation', settled({ operation: OPERATION })],
  ['idle work with an operation', live({ state: 'idle', operation: OPERATION })],
  ['unverifiable work with an operation', live({ state: 'unverifiable', operation: OPERATION })],
  [
    'a monitoring shell with an operation',
    live({ kind: 'command', state: 'monitoring', operation: OPERATION })
  ]
]

const LEGAL: [string, AgentChildWorkInput][] = [
  ['working', live()],
  ['waiting', live({ state: 'waiting' })],
  ['blocked', live({ state: 'blocked' })],
  ['idle (parked, resumable)', live({ state: 'idle' })],
  ['unverifiable (host lost the evidence path)', live({ state: 'unverifiable' })],
  ['a shell storing monitoring', live({ kind: 'command', state: 'monitoring' })],
  ['a monitor storing monitoring', live({ kind: 'monitor', state: 'monitoring' })],
  ['working with an operation', live({ operation: OPERATION })],
  ['waiting with an operation', live({ state: 'waiting', operation: OPERATION })],
  ['blocked with an operation', live({ state: 'blocked', operation: OPERATION })],
  ['succeeded', settled()],
  ['failed', settled({ outcome: 'failed' })],
  ['cancelled', settled({ outcome: 'cancelled' })],
  ['ended, outcome unknown', settled({ outcome: 'unknown' })],
  ['settled at first sight', settled({ settledAt: 10 })],
  ['settled at its newest evidence', settled({ settledAt: 20 })],
  ['settled with its last message', settled({ lastMessage: 'All tests pass' })]
]

describe('child-work legality matrix', () => {
  it.each(ILLEGAL)('rejects %s', (_cell, value) => {
    expect(parseAgentChildWorkInput(value)).toBeNull()
  })

  it.each(LEGAL)('admits %s unchanged', (_cell, value) => {
    expect(parseAgentChildWorkInput(value)).toEqual(value)
  })
})

describe('child-work descriptive fields', () => {
  it('round-trips owner, residency, operation, last message and settle time', () => {
    const value = {
      ...live({
        parentChildWorkId: 'child-owner',
        residency: 'background',
        operation: OPERATION,
        lastMessage: 'Running the suite'
      }),
      revision: 3
    }
    expect(parseAgentChildWorkRecord(value)).toEqual(value)
  })

  it('admits text already in its one-line form, at the caps', () => {
    const value = live({
      name: 'x'.repeat(512),
      description: 'Map the codebase\u00a0now',
      operation: { ...OPERATION, toolName: 'x'.repeat(60), input: 'y'.repeat(160) },
      lastMessage: 'z'.repeat(512)
    })
    expect(parseAgentChildWorkInput(value)).toEqual(value)
  })

  // Admission drops bad provider facts before they reach the codec, so each of these is a writer
  // bug: the codec refuses the record rather than repairing it.
  it.each([
    ['an operation that is not an object', { operation: 'Bash' }],
    ['an operation with an unknown key', { operation: { ...OPERATION, raw: {} } }],
    ['an operation with no tool name', { operation: { ...OPERATION, toolName: '' } }],
    [
      'a tool name longer than a status row carries',
      { operation: { ...OPERATION, toolName: 'x'.repeat(61) } }
    ],
    ['a multi-line tool input', { operation: { ...OPERATION, input: 'a\nb' } }],
    [
      'a tool input longer than a status row carries',
      { operation: { ...OPERATION, input: 'x'.repeat(161) } }
    ],
    ['an unknown operation basis', { operation: { ...OPERATION, basis: 'guessed' } }],
    ['an operation observed before the child', { operation: { ...OPERATION, observedAt: 9 } }],
    [
      'an operation observed after the newest evidence',
      { operation: { ...OPERATION, observedAt: 21 } }
    ],
    ['an unknown residency', { residency: 'detached' }],
    ['a last message longer than 512', { lastMessage: 'x'.repeat(513) }],
    ['a multi-line last message', { lastMessage: 'one\ntwo' }],
    ['a last message ending in a space', { lastMessage: 'cut here ' }],
    ['a last message with a line separator', { lastMessage: 'one\u2028two' }],
    ['a name with a next-line control', { name: 'one\u0085two' }],
    ['a name with a tab', { name: 'one\ttwo' }],
    ['a description ending in a space', { description: 'cut here ' }],
    ['a model longer than 512', { model: 'x'.repeat(513) }],
    ['a negative token count', { totalTokens: -1 }],
    ['an empty owner id', { parentChildWorkId: '' }],
    ['a child that owns itself', { parentChildWorkId: 'child-1' }],
    ['an unknown top-level key', { note: 'x' }],
    [
      'a settle time that is not a timestamp',
      { membership: 'settled', state: 'done', outcome: 'failed', settledAt: -1 }
    ],
    [
      'an outcome outside the vocabulary',
      { membership: 'settled', state: 'done', outcome: 'crashed' }
    ]
  ])('rejects %s', (_case, field) => {
    expect(parseAgentChildWorkInput({ ...live(), ...field })).toBeNull()
  })
})

describe('restored settled children written before outcome and settle time existed', () => {
  // The shape the previous codec admitted: settled, `done`, with no outcome and no settle time.
  const legacySettled = {
    ...live({ state: 'done', membership: 'settled' }),
    revision: 1
  }

  it('reads as an unknown ending at its newest evidence, never as success', () => {
    expect(parseAgentChildWorkRecord(legacySettled)).toEqual({
      ...legacySettled,
      outcome: 'unknown',
      settledAt: 20
    })
  })

  it('survives a store snapshot restore and carries its unknown outcome into resume history', () => {
    const source = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    expect(source.applyMutation({ parent: { subject: parent } })).not.toBeNull()
    expect(source.applyMutation({ children: [live()] })).not.toBeNull()
    const snapshot = source.getSnapshot()
    const restored = createAgentStatusStore({ epoch: 'epoch-b', mode: 'authority' })
    expect(
      restored.applySnapshot({
        ...snapshot,
        children: snapshot.children.map((child) => ({ ...child, ...legacySettled }))
      })
    ).toBe(true)
    expect(restored.getChild('child-1')).toMatchObject({ outcome: 'unknown', settledAt: 20 })

    const admission = createAgentChildWorkAdmission(restored, { mintChildWorkId: vi.fn() })
    expect(
      admission.resume({
        parent,
        provider: 'claude',
        childWorkId: 'child-1',
        expectedFence: { invocationId: 'invocation-1', generation: 1 },
        nextFence: { invocationId: 'invocation-2', generation: 2 },
        aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-1' }],
        kind: 'agent',
        state: 'working',
        membership: 'live',
        observedAt: 30,
        stoppable: true,
        provenance: { source: 'restore', producerId: 'roster' }
      })
    ).toMatchObject({ accepted: true })
    expect(restored.getChild('child-1')?.previousInvocations).toEqual([
      {
        fence: { invocationId: 'invocation-1', generation: 1 },
        outcome: 'unknown',
        settledAt: 20
      }
    ])
  })
})
