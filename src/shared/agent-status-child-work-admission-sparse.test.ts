import { describe, expect, it, vi } from 'vitest'
import {
  createAgentChildWorkAdmission,
  type AgentChildWorkAnnounceRequest
} from './agent-status-child-work-admission'
import { createAgentStatusStore } from './agent-status-store'
import { makeStructuredAgentStatusSubject } from './agent-status-subject'

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

const described = {
  name: 'researcher',
  description: 'Map the codebase',
  agentType: 'Explore',
  model: 'model-a',
  totalTokens: 5_000
} as const

function setup() {
  const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let sequence = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: vi.fn(() => `child-${++sequence}`)
  })
  return { store, admission }
}

describe('child-work admission of sparse observations', () => {
  it('keeps what the child was called when the ending names only that it is gone', () => {
    const { store, admission } = setup()
    admission.announce(observation(described))
    expect(
      admission.announce(
        observation({ state: 'done', membership: 'settled', outcome: 'unknown', observedAt: 20 })
      )
    ).toMatchObject({ accepted: true })
    expect(store.getChild('child-1')).toMatchObject({ membership: 'settled', ...described })
  })

  it('keeps the recorded last message when a refinement names only the outcome', () => {
    const { store, admission } = setup()
    admission.announce(observation({ name: 'researcher' }))
    admission.announce(
      observation({
        state: 'done',
        membership: 'settled',
        outcome: 'unknown',
        observedAt: 20,
        lastMessage: 'wrote 3 files'
      })
    )
    expect(
      admission.announce(
        observation({ state: 'done', membership: 'settled', outcome: 'failed', observedAt: 21 })
      )
    ).toMatchObject({ accepted: true })
    expect(store.getChild('child-1')).toMatchObject({
      outcome: 'failed',
      name: 'researcher',
      lastMessage: 'wrote 3 files',
      settledAt: 20
    })
  })

  it('keeps the last message, owner and residency through a settle that names none of them', () => {
    const { store, admission } = setup()
    admission.announce(observation())
    admission.announce(
      observation({
        aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'shell-1' }],
        kind: 'command',
        parentChildWorkId: 'child-1',
        residency: 'background',
        lastMessage: 'listening on 3000'
      })
    )
    admission.announce(observation({ state: 'working', observedAt: 12 }))
    expect(
      admission.announce(
        observation({
          aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'shell-1' }],
          kind: 'command',
          state: 'done',
          membership: 'settled',
          observedAt: 20
        })
      )
    ).toMatchObject({ accepted: true })
    expect(store.getChild('child-2')).toMatchObject({
      membership: 'settled',
      parentChildWorkId: 'child-1',
      residency: 'background',
      lastMessage: 'listening on 3000'
    })
  })

  it('never shrinks the token count on a late or duplicate frame', () => {
    const { store, admission } = setup()
    admission.announce(observation({ totalTokens: 5_000 }))
    admission.announce(observation({ totalTokens: 100, observedAt: 12 }))
    expect(store.getChild('child-1')?.totalTokens).toBe(5_000)
    admission.announce(observation({ totalTokens: 7_500, observedAt: 13 }))
    expect(store.getChild('child-1')?.totalTokens).toBe(7_500)
  })

  it('refuses a refinement stamped behind the settle it refines and keeps the record', () => {
    const { store, admission } = setup()
    admission.announce(observation())
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'unknown', observedAt: 20 })
    )
    const before = store.getChild('child-1')
    expect(
      admission.announce(
        observation({ state: 'done', membership: 'settled', outcome: 'failed', observedAt: 15 })
      )
    ).toMatchObject({ accepted: false })
    expect(store.getChild('child-1')).toEqual(before)
  })

  it('replaces a label the request carries and keeps the count over an invalid one', () => {
    const { store, admission } = setup()
    admission.announce(observation(described))
    admission.announce(observation({ name: 'reviewer', observedAt: 11 }))
    expect(store.getChild('child-1')).toMatchObject({ ...described, name: 'reviewer' })
    expect(admission.announce(observation({ totalTokens: -1, observedAt: 12 }))).toMatchObject({
      accepted: true
    })
    expect(store.getChild('child-1')?.totalTokens).toBe(5_000)
  })

  function settledFirstRun() {
    const { store, admission } = setup()
    admission.announce(
      observation({
        ...described,
        state: 'done',
        membership: 'settled',
        outcome: 'succeeded',
        observedAt: 20,
        parentChildWorkId: 'child-spawner',
        lastMessage: 'First run done',
        providerTiming: { startedAt: 12, completedAt: 20 }
      })
    )
    const resume = (overrides: Partial<AgentChildWorkAnnounceRequest> = {}) =>
      admission.resume({
        ...observation({ observedAt: 30, ...overrides }),
        childWorkId: 'child-1',
        expectedFence: { invocationId: 'invocation-1', generation: 1 },
        nextFence: { invocationId: 'invocation-2', generation: 2 }
      })
    return { store, resume }
  }

  it('carries labels and tokens into a resumed invocation but not its ending, timing or spawner', () => {
    const { store, resume } = settledFirstRun()
    expect(store.getChild('child-1')?.providerTiming).toEqual({ startedAt: 12, completedAt: 20 })
    expect(resume()).toMatchObject({ accepted: true })
    const child = store.getChild('child-1')
    expect(child).toMatchObject({ membership: 'live', ...described })
    expect(child).not.toHaveProperty('lastMessage')
    // The first run's completion time would claim the live restart had already finished.
    expect(child).not.toHaveProperty('providerTiming')
    // Restarted by the main agent: it no longer nests under the child that first spawned it.
    expect(child).not.toHaveProperty('parentChildWorkId')
  })

  it('nests a resumed invocation under the child that restarted it', () => {
    const { store, resume } = settledFirstRun()
    expect(resume({ parentChildWorkId: 'child-restarter' })).toMatchObject({ accepted: true })
    expect(store.getChild('child-1')?.parentChildWorkId).toBe('child-restarter')
  })
})
