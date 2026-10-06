import { describe, expect, it, vi } from 'vitest'
import {
  createAgentChildWorkAdmission,
  type AgentChildWorkAnnounceRequest
} from './agent-status-child-work-admission'
import { AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX } from './agent-status-child-work'
import { serializeAgentChildWorkAliasKey } from './agent-status-child-work-alias'
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
  it('keeps one host id across re-announcement with another tool-use alias', () => {
    const parent = subject()
    const { admission, mintChildWorkId, store } = setup([parent])

    expect(admission.announce(announce(parent))).toMatchObject({
      accepted: true,
      childWorkId: 'child-1',
      created: true
    })
    expect(
      admission.announce(
        announce(parent, {
          aliases: [
            { segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-1' },
            { segmentId: 'segment-1', aliasKind: 'tool_use_id', alias: 'tool-2' }
          ],
          observedAt: 11
        })
      )
    ).toMatchObject({ accepted: true, childWorkId: 'child-1', created: false })
    expect(mintChildWorkId).toHaveBeenCalledTimes(1)
    expect(store.getChildren(parent)).toHaveLength(1)
    expect(store.getSnapshot().aliases).toHaveLength(2)
  })

  it('admits a child without materializing the entire store snapshot', () => {
    const parent = subject()
    const { admission, store } = setup([parent])
    const snapshot = vi.spyOn(store, 'getSnapshot')

    expect(admission.announce(announce(parent)).accepted).toBe(true)
    expect(admission.announce(announce(parent, { observedAt: 11 })).accepted).toBe(true)
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('adopts and reclassifies a provisional child without changing its id', () => {
    const parent = subject()
    const { admission, store } = setup([parent])
    const first = admission.announce(
      announce(parent, {
        kind: 'unknown',
        aliases: [{ segmentId: 'segment-1', aliasKind: 'tool_use_id', alias: 'tool-1' }]
      })
    )
    expect(first).toMatchObject({ accepted: true, childWorkId: 'child-1' })

    expect(
      admission.adopt({
        ...announce(parent, { kind: 'agent', observedAt: 12 }),
        childWorkId: 'child-1',
        expectedFence: { invocationId: 'invocation-1', generation: 1 },
        aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-1' }]
      })
    ).toMatchObject({ accepted: true, childWorkId: 'child-1', created: false })
    expect(store.getChildren(parent)).toMatchObject([{ childWorkId: 'child-1', kind: 'agent' }])
    expect(store.getSnapshot().aliases.every((alias) => alias.kind === 'agent')).toBe(true)
  })

  it('preserves the logical id and prior outcome across an explicit resume fence', () => {
    const parent = subject()
    const { admission, store } = setup([parent])
    admission.announce(
      announce(parent, {
        state: 'done',
        membership: 'settled',
        outcome: 'failed',
        observedAt: 20
      })
    )

    expect(
      admission.resume({
        ...announce(parent, {
          aliases: [{ segmentId: 'segment-2', aliasKind: 'task_id', alias: 'task-1' }],
          observedAt: 30
        }),
        childWorkId: 'child-1',
        expectedFence: { invocationId: 'invocation-1', generation: 1 },
        nextFence: { invocationId: 'invocation-2', generation: 2 }
      })
    ).toMatchObject({ accepted: true, childWorkId: 'child-1', created: false })

    expect(store.getChildren(parent)[0]).toMatchObject({
      childWorkId: 'child-1',
      firstObservedAt: 20,
      invocation: { invocationId: 'invocation-2', generation: 2 },
      previousInvocations: [
        {
          fence: { invocationId: 'invocation-1', generation: 1 },
          outcome: 'failed',
          settledAt: 20
        }
      ]
    })
  })

  it('rejects a backwards resume generation before it can authorize stale stop input', () => {
    const parent = subject()
    const { admission, store } = setup([parent])
    admission.announce(
      announce(parent, {
        fence: { invocationId: 'invocation-5', generation: 5 }
      })
    )
    const before = store.getSnapshot()

    expect(
      admission.resume({
        ...announce(parent, { observedAt: 20 }),
        childWorkId: 'child-1',
        expectedFence: { invocationId: 'invocation-5', generation: 5 },
        nextFence: { invocationId: 'invocation-4', generation: 4 }
      })
    ).toEqual({ accepted: false, reason: 'stale-invocation' })
    expect(store.getSnapshot()).toEqual(before)
  })

  it('retires aliases when their invocation fence ages out of bounded history', () => {
    const parent = subject()
    const { admission, store } = setup([parent])
    expect(admission.announce(announce(parent)).accepted).toBe(true)

    for (
      let generation = 2;
      generation <= AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX + 2;
      generation += 1
    ) {
      const reusesOldestAlias = generation === AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX + 2
      expect(
        admission.resume({
          ...announce(parent, {
            aliases: [
              {
                segmentId: reusesOldestAlias ? 'segment-1' : `segment-${generation}`,
                aliasKind: 'task_id',
                alias: reusesOldestAlias ? 'task-1' : `task-${generation}`
              }
            ],
            observedAt: 10 + generation
          }),
          childWorkId: 'child-1',
          expectedFence: {
            invocationId: `invocation-${generation - 1}`,
            generation: generation - 1
          },
          nextFence: { invocationId: `invocation-${generation}`, generation }
        })
      ).toMatchObject({ accepted: true, childWorkId: 'child-1' })
    }

    const aliases = store.getAliasesForChild('child-1')
    expect(aliases).toHaveLength(AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX + 1)
    expect(aliases.some((entry) => entry.fence.generation === 1)).toBe(false)
    expect(aliases.find((entry) => entry.alias === 'task-1')?.fence.generation).toBe(
      AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX + 2
    )
  })

  it('rejects delayed observations resolved through a previous invocation alias', () => {
    const parent = subject()
    const { admission, store } = setup([parent])
    expect(admission.announce(announce(parent)).accepted).toBe(true)
    expect(
      admission.resume({
        ...announce(parent, {
          aliases: [{ segmentId: 'segment-2', aliasKind: 'task_id', alias: 'task-2' }],
          observedAt: 20
        }),
        childWorkId: 'child-1',
        expectedFence: { invocationId: 'invocation-1', generation: 1 },
        nextFence: { invocationId: 'invocation-2', generation: 2 }
      })
    ).toMatchObject({ accepted: true, childWorkId: 'child-1' })
    const before = store.getSnapshot()

    expect(
      admission.announce(
        announce(parent, {
          state: 'done',
          membership: 'settled',
          outcome: 'succeeded',
          observedAt: 30
        })
      )
    ).toEqual({ accepted: false, reason: 'stale-invocation' })
    expect(store.getSnapshot()).toEqual(before)
  })

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

  it('fails closed for settled or non-stoppable stop targets', () => {
    const parent = subject()
    const { admission } = setup([parent])
    admission.announce(announce(parent, { stoppable: false }))
    const stop = {
      parent,
      childWorkId: 'child-1',
      expectedFence: { invocationId: 'invocation-1', generation: 1 }
    }
    expect(admission.authorizeStop(stop)).toBeNull()

    const second = setup([parent])
    second.admission.announce(
      announce(parent, { state: 'done', membership: 'settled', outcome: 'succeeded' })
    )
    expect(second.admission.authorizeStop(stop)).toBeNull()
  })

  it('scopes identical aliases by parent, provider, segment and kind', () => {
    const firstParent = subject()
    const secondParent = subject({ executionHostId: 'ssh:host-a' })
    const { admission, store } = setup([firstParent, secondParent])

    const requests = [
      announce(firstParent),
      announce(secondParent),
      announce(firstParent, { provider: 'codex' }),
      announce(firstParent, {
        aliases: [{ segmentId: 'segment-2', aliasKind: 'task_id', alias: 'task-1' }]
      }),
      announce(firstParent, { kind: 'workflow' })
    ]
    for (const request of requests) {
      expect(admission.announce(request).accepted).toBe(true)
    }

    expect(store.getSnapshot().children).toHaveLength(5)
    expect(new Set(store.getSnapshot().aliases.map(serializeAgentChildWorkAliasKey)).size).toBe(5)
  })

  it('reparents a child and all aliases without reminting identity', () => {
    const firstParent = subject()
    const nextParent = subject({ workspaceId: 'workspace-2' })
    const { admission, store, mintChildWorkId } = setup([firstParent, nextParent])
    admission.announce(announce(firstParent))

    expect(
      admission.reparent({
        childWorkId: 'child-1',
        fromParent: firstParent,
        toParent: nextParent,
        expectedFence: { invocationId: 'invocation-1', generation: 1 },
        observedAt: 20
      })
    ).toMatchObject({ accepted: true, childWorkId: 'child-1', created: false })
    expect(store.getChildren(firstParent)).toEqual([])
    expect(store.getChildren(nextParent)[0]?.childWorkId).toBe('child-1')
    expect(store.getSnapshot().aliases[0]?.parent).toEqual(nextParent)
    expect(mintChildWorkId).toHaveBeenCalledTimes(1)
  })
})
