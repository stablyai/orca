import { describe, expect, it, vi } from 'vitest'
import {
  createAgentChildWorkAdmission,
  type AgentChildWorkAnnounceRequest
} from './agent-status-child-work-admission'
import { createAgentStatusStore } from '../store/agent-status-store'
import {
  makeStructuredAgentStatusSubject,
  type AgentStatusExecutionScope,
  type AgentStatusSubject
} from '../contracts/agent-status-subject'

const SESSION_ID = 'session_11111111-1111-4111-8111-111111111111'

function subject(overrides: Partial<AgentStatusExecutionScope> = {}): AgentStatusSubject {
  return makeStructuredAgentStatusSubject(
    {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree',
      ...overrides
    },
    SESSION_ID
  )
}

function announce(
  parent: AgentStatusSubject,
  overrides: Partial<AgentChildWorkAnnounceRequest> = {}
): AgentChildWorkAnnounceRequest {
  return {
    parent,
    provider: 'claude',
    aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-1' }],
    fence: { invocationId: 'invocation-1', generation: 1 },
    lifetime: 'current',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    observedAt: 10,
    stoppable: true,
    provenance: { source: 'structured-session', producerId: 'journal-1' },
    ...overrides
  }
}

function setup(parents: AgentStatusSubject[] = [subject()]) {
  const ids = ['child-1', 'child-2', 'child-3', 'child-4']
  const mintChildWorkId = vi.fn(() => ids.shift() ?? 'child-overflow')
  const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  for (const parent of parents) {
    expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  }
  return {
    store,
    mintChildWorkId,
    admission: createAgentChildWorkAdmission(store, { mintChildWorkId })
  }
}

describe('agent child-work admission', () => {
  it('mints a distinct id for proven reuse and rejects delayed predecessor updates and stops', () => {
    const parent = subject()
    const { admission, store } = setup([parent])
    admission.announce(
      announce(parent, {
        state: 'done',
        membership: 'settled',
        outcome: 'succeeded',
        observedAt: 20
      })
    )
    const successor = announce(parent, {
      fence: { invocationId: 'invocation-2', generation: 2 },
      lifetime: 'proven-new',
      observedAt: 30
    })
    expect(admission.announce(successor)).toMatchObject({
      accepted: true,
      childWorkId: 'child-2',
      created: true
    })
    expect(store.getChildren(parent).map((child) => child.childWorkId)).toEqual([
      'child-1',
      'child-2'
    ])

    expect(admission.announce(announce(parent, { observedAt: 40 }))).toEqual({
      accepted: false,
      reason: 'stale-invocation'
    })
    expect(
      admission.authorizeStop({
        parent,
        childWorkId: 'child-2',
        expectedFence: { invocationId: 'invocation-1', generation: 1 }
      })
    ).toBeNull()
    expect(
      admission.authorizeStop({
        parent,
        childWorkId: 'child-2',
        expectedFence: { invocationId: 'invocation-2', generation: 2 }
      })?.childWorkId
    ).toBe('child-2')
  })
})
