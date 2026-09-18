import { describe, expect, it } from 'vitest'
import { createAgentChildWorkAdmission } from './agent-status-child-work-admission'
import { createAgentStatusStore } from './agent-status-store'
import {
  makeStructuredAgentStatusSubject,
  type AgentStatusExecutionScope,
  type AgentStatusSubject
} from './agent-status-subject'

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

function request(parent: AgentStatusSubject, kind: 'agent' | 'unknown') {
  return {
    parent,
    provider: 'claude',
    aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id' as const, alias: 'task-1' }],
    fence: { invocationId: `invocation-${kind}`, generation: kind === 'unknown' ? 1 : 2 },
    lifetime: 'current' as const,
    kind,
    state: 'working' as const,
    membership: 'live' as const,
    observedAt: 10,
    stoppable: true,
    provenance: { source: 'structured-session' as const, producerId: 'journal-1' }
  }
}

describe('agent child-work admission collisions', () => {
  it('rejects an adopt whose alias reclassification would capture another child', () => {
    const parent = subject()
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    store.applyMutation({ parent: { subject: parent } })
    const ids = ['child-1', 'child-2']
    const admission = createAgentChildWorkAdmission(store, {
      mintChildWorkId: () => ids.shift() ?? 'unexpected-child'
    })
    admission.announce(request(parent, 'unknown'))
    admission.announce(request(parent, 'agent'))
    const before = store.getSnapshot()

    expect(
      admission.adopt({
        ...request(parent, 'unknown'),
        childWorkId: 'child-1',
        expectedFence: { invocationId: 'invocation-unknown', generation: 1 },
        kind: 'agent',
        observedAt: 20
      })
    ).toEqual({ accepted: false, reason: 'ambiguous' })
    expect(store.getSnapshot()).toEqual(before)
  })

  it('rejects reparenting into an occupied alias scope without moving the child', () => {
    const firstParent = subject()
    const nextParent = subject({ workspaceId: 'workspace-2' })
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    store.applyMutation({ parent: { subject: firstParent } })
    store.applyMutation({ parent: { subject: nextParent } })
    const ids = ['child-1', 'child-2']
    const admission = createAgentChildWorkAdmission(store, {
      mintChildWorkId: () => ids.shift() ?? 'unexpected-child'
    })
    admission.announce(request(firstParent, 'agent'))
    admission.announce(request(nextParent, 'agent'))
    const before = store.getSnapshot()

    expect(
      admission.reparent({
        childWorkId: 'child-1',
        fromParent: firstParent,
        toParent: nextParent,
        expectedFence: { invocationId: 'invocation-agent', generation: 2 },
        observedAt: 20
      })
    ).toEqual({ accepted: false, reason: 'ambiguous' })
    expect(store.getSnapshot()).toEqual(before)
  })
})
