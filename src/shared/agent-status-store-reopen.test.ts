import { describe, expect, it } from 'vitest'
import { createAgentStatusStore } from './agent-status-store'
import {
  makePtyRunAgentStatusSubject,
  makeStructuredAgentStatusSubject
} from './agent-status-subject'

const scope = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-one',
  workspaceKind: 'folder'
} as const
const subject = makeStructuredAgentStatusSubject(scope, 'durable-session')

describe('structured parent reopening', () => {
  it('reopens a removed structured parent and refuses a replay whose revision pair is spent', () => {
    const owner = createAgentStatusStore({ epoch: 'host', mode: 'authority' })
    const replica = createAgentStatusStore({ epoch: 'reader', mode: 'replica' })
    const oldPublication = owner.applyMutation({ parent: { subject, firstObservedAt: 10 } })
    expect(oldPublication).not.toBeNull()
    expect(replica.applySnapshot(owner.getSnapshot())).toBe(true)
    const removal = owner.applyMutation({ removeParent: subject })
    expect(removal).not.toBeNull()
    expect(replica.applyTransportEnvelope(removal)).toBe(true)
    expect(replica.getParent(subject)).toBeNull()

    const reopened = owner.applyMutation({ parent: { subject, firstObservedAt: 30 } })
    expect(reopened).not.toBeNull()
    expect(replica.applyTransportEnvelope(reopened)).toBe(true)
    expect(replica.getParent(subject)).toEqual(owner.getParent(subject))
    expect(replica.getParent(subject)?.firstObservedAt).toBe(30)

    // Outcome only, deliberately: a spent replay is refused and a resequenced one is not. Which
    // layer refuses it is NOT asserted, because no test at this API can tell — transport
    // consecutiveness, the parent-revision validator and the tombstone guard each refuse it alone,
    // and ablating any two leaves this green. Attributing one of them here would be a false claim.
    expect(replica.applyTransportEnvelope(oldPublication)).toBe(false)
    expect(replica.getParent(subject)?.firstObservedAt).toBe(30)
    const resequenced = owner.applyMutation({ parent: { subject, firstObservedAt: 10 } })
    expect(resequenced).not.toBeNull()
    expect(replica.applyTransportEnvelope(resequenced)).toBe(true)
    expect(replica.getParent(subject)?.firstObservedAt).toBe(10)
    expect(replica.getSnapshot()).toEqual(owner.getSnapshot())
  })

  it('fences a republication only inside the removing mutation, for every subject kind', () => {
    const owner = createAgentStatusStore({ epoch: 'host', mode: 'authority' })
    const pty = makePtyRunAgentStatusSubject(scope, 'retired-run')
    expect(owner.applyMutation({ parent: { subject: pty } })).not.toBeNull()
    expect(owner.applyMutation({ removeParent: pty })).not.toBeNull()

    // Same mutation: the tombstone shares this revision, so it outranks the republication.
    const contradiction = owner.getSnapshot()
    expect(owner.applyMutation({ removeParent: subject, parent: { subject } })).toBeNull()
    expect(owner.getSnapshot()).toEqual(contradiction)

    // A later mutation outranks the tombstone regardless of kind — PTY runs included.
    expect(owner.applyMutation({ parent: { subject: pty } })).not.toBeNull()
    expect(owner.getParent(pty)).not.toBeNull()

    expect(owner.applyMutation({})).toBeNull()
  })
})
