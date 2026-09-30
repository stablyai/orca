import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusStore } from './agent-status-store'
import { AGENT_STATUS_STORE_LIMITS } from './agent-status-store-contract'
import { makeStructuredAgentStatusSubject } from './agent-status-subject'
import {
  deserializeAgentStatusTransportEnvelope,
  serializeAgentStatusTransportEnvelope
} from './agent-status-transport-envelope'

const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree'
  },
  'session_11111111-1111-4111-8111-111111111111'
)

describe('agent status transport envelope', () => {
  it('requires a snapshot before replay and then accepts only contiguous same-epoch mutations', () => {
    const authority = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const first = authority.applyMutation({ parent: { subject: parent, firstObservedAt: 10 } })
    expect(first).not.toBeNull()

    const replica = createAgentStatusStore({ epoch: 'replica-placeholder', mode: 'replica' })
    expect(replica.applyTransportEnvelope(first)).toBe(false)
    expect(
      replica.applyTransportEnvelope({ type: 'snapshot', snapshot: authority.getSnapshot() })
    ).toBe(true)

    const second = authority.applyMutation({
      facts: [{ subject: parent, key: 'acknowledged', value: true }]
    })
    expect(replica.applyTransportEnvelope(second)).toBe(true)
    expect(replica.getSnapshot()).toEqual(authority.getSnapshot())
    expect(replica.applyTransportEnvelope(second)).toBe(false)
    expect(
      replica.applyTransportEnvelope({
        ...second,
        previousRevision: 9,
        revision: 10
      })
    ).toBe(false)
  })

  it('adopts a restart snapshot before replay and rejects the predecessor epoch', () => {
    const firstAuthority = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    firstAuthority.applyMutation({ parent: { subject: parent } })
    const persisted = firstAuthority.getSnapshot()
    const replica = createAgentStatusStore({ epoch: 'replica-placeholder', mode: 'replica' })
    replica.applySnapshot(persisted)
    const stale = firstAuthority.applyMutation({
      facts: [{ subject: parent, key: 'unread', value: true }]
    })

    const restarted = createAgentStatusStore({ epoch: 'epoch-b', mode: 'authority' })
    expect(restarted.applySnapshot(persisted)).toBe(true)
    const restartedSnapshot = restarted.getSnapshot()
    expect(restartedSnapshot.epoch).toBe('epoch-b')
    expect(replica.applySnapshot(restartedSnapshot)).toBe(true)
    expect(replica.applyTransportEnvelope(stale)).toBe(false)

    const fresh = restarted.applyMutation({
      facts: [{ subject: parent, key: 'retained', value: true }]
    })
    expect(replica.applyTransportEnvelope(fresh)).toBe(true)
    expect(replica.getSnapshot().facts.map((fact) => fact.key)).toEqual(['retained'])
  })

  it('round-trips a mutation envelope and fails closed on malformed or oversized input', () => {
    const authority = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const mutation = authority.applyMutation({ parent: { subject: parent } })
    expect(mutation).not.toBeNull()
    if (!mutation) {
      return
    }

    expect(
      deserializeAgentStatusTransportEnvelope(serializeAgentStatusTransportEnvelope(mutation))
    ).toEqual(mutation)
    expect(
      deserializeAgentStatusTransportEnvelope(
        JSON.stringify({ ...mutation, revision: mutation.revision + 2 })
      )
    ).toBeNull()

    const parse = vi.spyOn(JSON, 'parse')
    expect(
      deserializeAgentStatusTransportEnvelope(
        ' '.repeat(AGENT_STATUS_STORE_LIMITS.serializedBytes + 1)
      )
    ).toBeNull()
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('does not resurrect an exact removal through stale replay', () => {
    const authority = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const insertion = authority.applyMutation({ parent: { subject: parent } })
    const replica = createAgentStatusStore({ epoch: 'replica-placeholder', mode: 'replica' })
    expect(replica.applySnapshot(authority.getSnapshot())).toBe(true)
    const removal = authority.applyMutation({ removeParent: parent })

    expect(replica.applyTransportEnvelope(removal)).toBe(true)
    expect(replica.getParent(parent)).toBeNull()
    expect(replica.applyTransportEnvelope(insertion)).toBe(false)
    expect(replica.getParent(parent)).toBeNull()
  })
})
