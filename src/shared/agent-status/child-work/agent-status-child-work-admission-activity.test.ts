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
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree'
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
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: vi.fn(() => `child-${++sequence}`)
  })
  return { store, admission }
}

describe('child-work settlement stamping', () => {
  it('refines an ending first recorded as unknown, keeping when it settled', () => {
    const { store, admission } = setup()
    admission.announce(observation())
    // Roster omission lands first, the frame naming the outcome in the same tick.
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'unknown', observedAt: 20 })
    )
    expect(
      admission.announce(
        observation({
          state: 'done',
          membership: 'settled',
          outcome: 'failed',
          observedAt: 20,
          lastMessage: 'Exit code 1'
        })
      )
    ).toMatchObject({ accepted: true, created: false })
    expect(store.getChild('child-1')).toMatchObject({
      outcome: 'failed',
      settledAt: 20,
      lastMessage: 'Exit code 1'
    })
  })
})
