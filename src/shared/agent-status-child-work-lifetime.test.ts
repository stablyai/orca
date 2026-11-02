import { describe, expect, it, vi } from 'vitest'
import { AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX } from './agent-status-child-work'
import {
  createAgentChildWorkAdmission,
  type AgentChildWorkAnnounceRequest
} from './agent-status-child-work-admission'
import { serializeAgentChildWorkAliasKey } from './agent-status-child-work-alias'
import { createAgentStatusStore } from './agent-status-store'
import {
  deserializeAgentStatusStoreSnapshot,
  serializeAgentStatusStoreSnapshot
} from './agent-status-store-persistence'
import { makeStructuredAgentStatusSubject } from './agent-status-subject'

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
  it('keeps set-valued alias bindings across proven reuse and persistence', () => {
    const { store, admission } = setup()
    expect(admission.announce(observation())).toMatchObject({
      accepted: true,
      childWorkId: 'child-1'
    })
    expect(
      admission.announce(
        observation({
          lifetime: 'proven-new',
          fence: { invocationId: 'invocation-2', generation: 2 },
          observedAt: 20
        })
      )
    ).toMatchObject({ accepted: true, childWorkId: 'child-2' })
    const snapshot = store.getSnapshot()
    expect(snapshot.aliases).toHaveLength(2)
    expect(new Set(snapshot.aliases.map(serializeAgentChildWorkAliasKey)).size).toBe(1)
    const restored = createAgentStatusStore({ epoch: 'epoch-b', mode: 'authority' })
    expect(
      restored.applySnapshot(
        deserializeAgentStatusStoreSnapshot(serializeAgentStatusStoreSnapshot(snapshot))
      )
    ).toBe(true)
    expect(restored.getSnapshot().aliases).toEqual(snapshot.aliases)
    expect(restored.getChildren(parent)).toEqual(snapshot.children)
  })

  it('rejects old alias updates and stops after resume without cloning a snapshot for admission', () => {
    const { store, admission } = setup()
    const snapshot = vi.spyOn(store, 'getSnapshot')
    admission.announce(observation())
    expect(
      admission.resume({
        ...observation({ observedAt: 20 }),
        childWorkId: 'child-1',
        expectedFence: observation().fence,
        nextFence: { invocationId: 'invocation-2', generation: 2 }
      })
    ).toMatchObject({ accepted: true })
    const before = store.getChild('child-1')
    expect(
      admission.announce(
        observation({ observedAt: 30, state: 'done', membership: 'settled', outcome: 'failed' })
      )
    ).toEqual({ accepted: false, reason: 'stale-invocation' })
    expect(
      admission.authorizeStop({
        parent,
        childWorkId: 'child-1',
        expectedFence: observation().fence
      })
    ).toBeNull()
    expect(store.getChild('child-1')).toEqual(before)
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('does not reactivate settled history via an ordinary re-announcement', () => {
    const { store, admission } = setup()
    admission.announce(observation({ state: 'done', membership: 'settled', outcome: 'cancelled' }))
    expect(admission.announce(observation({ observedAt: 20 }))).toEqual({
      accepted: false,
      reason: 'stale-invocation'
    })
    expect(store.getChild('child-1')).toMatchObject({ membership: 'settled', outcome: 'cancelled' })
  })

  it('does not remint a deleted child from a delayed observation after restart', () => {
    const { store, admission } = setup()
    admission.announce(observation())
    expect(store.applyMutation({ removeChildren: ['child-1'] })).not.toBeNull()
    const restored = createAgentStatusStore({ epoch: 'epoch-b', mode: 'authority' })
    expect(restored.applySnapshot(store.getSnapshot())).toBe(true)
    const mintChildWorkId = vi.fn(() => 'replacement')
    const restarted = createAgentChildWorkAdmission(restored, { mintChildWorkId })
    expect(restarted.announce(observation({ observedAt: 30 })).accepted).toBe(false)
    expect(
      restarted.announce(observation({ lifetime: 'proven-new', observedAt: 30 })).accepted
    ).toBe(false)
    expect(mintChildWorkId).not.toHaveBeenCalled()
    expect(restored.getChildren(parent)).toEqual([])
  })

  it('retains retired-fence rejection beyond bounded invocation history', () => {
    const { store, admission } = setup()
    admission.announce(observation())
    for (
      let generation = 2;
      generation <= AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX + 3;
      generation++
    ) {
      expect(
        admission.resume({
          ...observation({ observedAt: generation * 10 }),
          childWorkId: 'child-1',
          expectedFence: {
            invocationId: `invocation-${generation - 1}`,
            generation: generation - 1
          },
          nextFence: { invocationId: `invocation-${generation}`, generation }
        })
      ).toMatchObject({ accepted: true })
    }
    expect(store.getChild('child-1')?.previousInvocations).toHaveLength(
      AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX
    )
    expect(store.getSnapshot().aliases).toHaveLength(AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX + 1)
    expect(admission.announce(observation({ observedAt: 1000 })).accepted).toBe(false)
    expect(
      admission.announce(observation({ observedAt: 1000, lifetime: 'proven-new' })).accepted
    ).toBe(false)
    expect(
      admission.resume({
        ...observation({ observedAt: 1000 }),
        childWorkId: 'child-1',
        expectedFence: { invocationId: 'invocation-35', generation: 35 },
        nextFence: observation().fence
      }).accepted
    ).toBe(false)
  })

  it('fences former parent and provisional-kind aliases after explicit moves', () => {
    const { store, admission, mintChildWorkId } = setup()
    admission.announce(observation({ kind: 'unknown' }))
    expect(
      admission.adopt({
        ...observation({ observedAt: 20 }),
        childWorkId: 'child-1',
        expectedFence: observation().fence
      })
    ).toMatchObject({ accepted: true })
    expect(admission.announce(observation({ kind: 'unknown', observedAt: 30 })).accepted).toBe(
      false
    )
    const toParent = { ...parent, workspaceId: 'folder-b' }
    expect(store.applyMutation({ parent: { subject: toParent } })).not.toBeNull()
    expect(
      admission.reparent({
        childWorkId: 'child-1',
        fromParent: parent,
        toParent,
        expectedFence: observation().fence,
        observedAt: 40
      })
    ).toMatchObject({ accepted: true })
    expect(admission.announce(observation({ observedAt: 50 })).accepted).toBe(false)
    expect(mintChildWorkId).toHaveBeenCalledTimes(1)
    expect(store.getChild('child-1')?.parent).toEqual(toParent)
  })
})
