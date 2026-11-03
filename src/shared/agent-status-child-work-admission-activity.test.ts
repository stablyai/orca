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

function setup() {
  const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let sequence = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: vi.fn(() => `child-${++sequence}`)
  })
  return { store, admission }
}

describe('child-work admission of what a child is doing', () => {
  it('clamps an operation stamped in another clock into the child evidence window', () => {
    const { store, admission } = setup()
    admission.announce(
      observation({ operation: { toolName: 'Bash', basis: 'open', observedAt: 5_000 } })
    )
    expect(store.getChild('child-1')?.operation).toMatchObject({ observedAt: 10 })
    admission.announce(
      observation({
        observedAt: 20,
        operation: { toolName: 'Read', basis: 'reported', observedAt: 3 }
      })
    )
    expect(store.getChild('child-1')?.operation).toEqual({
      toolName: 'Read',
      basis: 'reported',
      observedAt: 10
    })
  })
})

describe('child-work settlement stamping', () => {
  it('admits a settle that still names an operation, clears it and keeps the last message', () => {
    const { store, admission } = setup()
    admission.announce(
      observation({ operation: { toolName: 'Bash', basis: 'open', observedAt: 10 } })
    )

    expect(
      admission.announce(
        observation({
          state: 'done',
          membership: 'settled',
          outcome: 'failed',
          observedAt: 20,
          operation: { toolName: 'Bash', basis: 'open', observedAt: 10 },
          lastMessage: 'Exit code 1'
        })
      )
    ).toMatchObject({ accepted: true })
    const child = store.getChild('child-1')
    expect(child).toMatchObject({
      membership: 'settled',
      outcome: 'failed',
      settledAt: 20,
      lastMessage: 'Exit code 1'
    })
    expect(child).not.toHaveProperty('operation')
  })

  it('stamps the settle time once and keeps it through later settled evidence', () => {
    const { store, admission } = setup()
    admission.announce(observation())
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'succeeded', observedAt: 20 })
    )
    expect(
      admission.announce(
        observation({
          state: 'done',
          membership: 'settled',
          outcome: 'succeeded',
          observedAt: 25,
          lastMessage: 'Summary arrived late'
        })
      )
    ).toMatchObject({ accepted: true })
    expect(store.getChild('child-1')).toMatchObject({ observedAt: 25, settledAt: 20 })
  })

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

  it('never changes a definite ending to a different one', () => {
    const { store, admission } = setup()
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'succeeded', observedAt: 20 })
    )
    const before = store.getChild('child-1')
    expect(
      admission.announce(
        observation({ state: 'done', membership: 'settled', outcome: 'failed', observedAt: 25 })
      )
    ).toEqual({ accepted: false, reason: 'stale-invocation' })
    expect(store.getChild('child-1')).toEqual(before)
  })

  it.each([
    ['an explicit unknown', { outcome: 'unknown' }],
    ['an omitted outcome', {}]
  ] as const)('keeps a definite ending through %s and admits the rest of it', (_case, ending) => {
    const { store, admission } = setup()
    admission.announce(
      observation({
        state: 'done',
        membership: 'settled',
        outcome: 'cancelled',
        observedAt: 20,
        lastMessage: 'Stopped by user'
      })
    )
    expect(
      admission.announce(
        observation({
          state: 'done',
          membership: 'settled',
          observedAt: 25,
          lastMessage: 'Cleanup finished',
          aliases: [
            { segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-1' },
            { segmentId: 'segment-1', aliasKind: 'tool_use_id', alias: 'toolu-1' }
          ],
          ...ending
        })
      )
    ).toMatchObject({ accepted: true, childWorkId: 'child-1', created: false })
    expect(store.getChild('child-1')).toMatchObject({
      outcome: 'cancelled',
      settledAt: 20,
      observedAt: 25,
      lastMessage: 'Cleanup finished'
    })
    expect(store.getAliasesForChild('child-1').map((alias) => alias.alias)).toContain('toolu-1')
  })

  it('records when the previous invocation settled, not its newest evidence, on resume', () => {
    const { store, admission } = setup()
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'failed', observedAt: 20 })
    )
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'failed', observedAt: 25 })
    )

    expect(
      admission.resume({
        ...observation({ observedAt: 30 }),
        childWorkId: 'child-1',
        expectedFence: { invocationId: 'invocation-1', generation: 1 },
        nextFence: { invocationId: 'invocation-2', generation: 2 }
      })
    ).toMatchObject({ accepted: true })
    const child = store.getChild('child-1')
    expect(child?.previousInvocations).toEqual([
      {
        fence: { invocationId: 'invocation-1', generation: 1 },
        outcome: 'failed',
        settledAt: 20
      }
    ])
    expect(child).toMatchObject({ membership: 'live', state: 'working' })
    expect(child).not.toHaveProperty('settledAt')
    expect(child).not.toHaveProperty('outcome')
  })
})
