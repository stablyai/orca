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

describe('trusted structured parent reopening', () => {
  it('requires explicit owner reopening and fences old replay after the new publication', () => {
    const owner = createAgentStatusStore({ epoch: 'host', mode: 'authority' })
    const replica = createAgentStatusStore({ epoch: 'reader', mode: 'replica' })
    const oldPublication = owner.applyMutation({ parent: { subject } })
    expect(oldPublication).not.toBeNull()
    expect(owner.applyMutation({ removeParent: subject })).not.toBeNull()
    expect(owner.applyMutation({ parent: { subject } })).toBeNull()
    expect(replica.applySnapshot(owner.getSnapshot())).toBe(true)
    const reopened = owner.applyMutation({ parent: { subject }, reopenStructuredParent: true })
    expect(reopened).not.toBeNull()
    expect(replica.applyTransportEnvelope(reopened)).toBe(true)
    expect(replica.getParent(subject)).toEqual(owner.getParent(subject))
    expect(replica.applyTransportEnvelope(oldPublication)).toBe(false)
    expect(replica.getSnapshot()).toEqual(owner.getSnapshot())
  })

  it('does not allow the structured reopen operation to revive a PTY run or a missing parent', () => {
    const owner = createAgentStatusStore({ epoch: 'host', mode: 'authority' })
    const pty = makePtyRunAgentStatusSubject(scope, 'retired-run')
    expect(owner.applyMutation({ removeParent: pty })).not.toBeNull()
    const before = owner.getSnapshot()
    expect(
      owner.applyMutation({ parent: { subject: pty }, reopenStructuredParent: true })
    ).toBeNull()
    expect(owner.applyMutation({ reopenStructuredParent: true })).toBeNull()
    expect(owner.getSnapshot()).toEqual(before)
  })
})
