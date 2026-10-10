import { describe, expect, it } from 'vitest'
import {
  AGENT_CHILD_WORK_KINDS,
  AGENT_CHILD_WORK_STATES,
  type AgentChildWorkInput
} from './agent-status-child-work'
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

function child(overrides: Partial<AgentChildWorkInput> = {}): AgentChildWorkInput {
  return {
    childWorkId: 'child-1',
    parent,
    provider: 'claude',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    name: 'Research',
    description: 'Investigate the contract',
    agentType: 'researcher',
    model: 'model-a',
    totalTokens: 42,
    providerTiming: { startedAt: 5, completedAt: 8 },
    firstObservedAt: 10,
    observedAt: 20,
    stoppable: true,
    invocation: { invocationId: 'invocation-1', generation: 1 },
    previousInvocations: [
      {
        fence: { invocationId: 'invocation-0', generation: 0 },
        outcome: 'cancelled',
        settledAt: 9
      }
    ],
    provenance: { source: 'structured-session', producerId: 'journal-1' },
    ...overrides
  }
}

describe('AgentChildWorkRecord', () => {
  it('round-trips the complete canonical vocabulary through the store snapshot', () => {
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
    const children = AGENT_CHILD_WORK_STATES.map((state, index) =>
      child({
        childWorkId: `child-${index}`,
        // Only a shell or a monitor may store `monitoring`.
        kind:
          state === 'monitoring'
            ? 'monitor'
            : AGENT_CHILD_WORK_KINDS[index % AGENT_CHILD_WORK_KINDS.length],
        state,
        membership: state === 'done' ? 'settled' : 'live',
        ...(state === 'done' ? { outcome: 'failed' } : {}),
        invocation: { invocationId: `invocation-${index}`, generation: index },
        previousInvocations: undefined
      })
    )

    expect(store.applyMutation({ children })).not.toBeNull()
    const snapshot = store.getSnapshot()
    expect(snapshot.children.map((item) => item.kind)).toEqual([
      'agent',
      'monitor',
      'command',
      'monitor',
      'unknown',
      'agent',
      'workflow'
    ])
    expect(snapshot.children.map((item) => item.state)).toEqual(AGENT_CHILD_WORK_STATES)
    expect(snapshot.children.find((item) => item.state === 'done')).toMatchObject({
      membership: 'settled',
      outcome: 'failed',
      totalTokens: 42,
      providerTiming: { startedAt: 5, completedAt: 8 },
      firstObservedAt: 10
    })
  })

  it('parses a copied record with outcome, tokens, timing and bounded invocation history', () => {
    const parsed = parseAgentChildWorkRecord({ ...child(), revision: 7 })

    expect(parsed).toEqual({ ...child(), revision: 7 })
    expect(parsed).not.toBe(child())
    expect(parsed?.parent).not.toBe(parent)
  })

  it.each([
    child({ childWorkId: 'bad\nid' }),
    child({ provider: 'claude\0forged' }),
    child({ firstObservedAt: 21 }),
    child({ totalTokens: -1 }),
    child({ membership: 'live', outcome: 'succeeded' }),
    child({
      previousInvocations: [
        { fence: { invocationId: 'invocation-1', generation: 1 }, outcome: 'failed' }
      ]
    }),
    child({
      previousInvocations: [
        { fence: { invocationId: 'old', generation: 1 } },
        { fence: { invocationId: 'old', generation: 1 } }
      ]
    })
  ])('rejects malformed canonical child input %#', (value) => {
    expect(parseAgentChildWorkInput(value)).toBeNull()
  })
})
