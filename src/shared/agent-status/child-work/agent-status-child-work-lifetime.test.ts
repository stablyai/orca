import { describe, expect, it, vi } from 'vitest'
import {
  createAgentChildWorkAdmission,
  type AgentChildWorkAnnounceRequest
} from './agent-status-child-work-admission'
import { createAgentStatusStore } from '../store/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../contracts/agent-status-subject'

const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'ssh:host-a',
    wslDistro: null,
    workspaceId: 'folder-a',
    workspaceKind: 'folder'
  },
  'session_11111111-1111-4111-8111-111111111111'
)

function observation(
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

function setup() {
  const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let sequence = 0
  const mintChildWorkId = vi.fn(() => `child-${++sequence}`)
  return {
    store,
    mintChildWorkId,
    admission: createAgentChildWorkAdmission(store, { mintChildWorkId })
  }
}

describe('child-work lifetime fencing', () => {
  it('does not reactivate settled history via an ordinary re-announcement', () => {
    const { store, admission } = setup()
    admission.announce(observation({ state: 'done', membership: 'settled', outcome: 'cancelled' }))
    expect(admission.announce(observation({ observedAt: 20 }))).toEqual({
      accepted: false,
      reason: 'stale-invocation'
    })
    expect(store.getChild('child-1')).toMatchObject({ membership: 'settled', outcome: 'cancelled' })
  })
})
