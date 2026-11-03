import { describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkInput } from './agent-status-child-work'
import { createAgentChildWorkAdmission } from './agent-status-child-work-admission'
import './agent-status-child-work-codec'
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

describe('restored settled children written before outcome and settle time existed', () => {
  // The shape the previous codec admitted: settled, `done`, with no outcome and no settle time.
  const legacySettled = {
    ...live({ state: 'done', membership: 'settled' }),
    revision: 1
  }

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
