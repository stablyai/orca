import { describe, expect, it } from 'vitest'
import { createAgentStatusStore } from './agent-status-store'
import { makeStructuredAgentStatusSubject } from '../contracts/agent-status-subject'

// Guards the status-row read fix: every session-tabs publication reads each chat's row, so a copy
// per read made main allocate in proportion to running chats times status updates.
const subject = makeStructuredAgentStatusSubject(
  { executionHostId: 'local', wslDistro: null, workspaceId: 'folder-one', workspaceKind: 'folder' },
  'session-one'
)

describe('agent status row reads', () => {
  it('returns the committed row instead of a fresh copy', () => {
    const store = createAgentStatusStore({ epoch: 'host', mode: 'authority' })
    store.applyMutation({ parent: { subject, firstObservedAt: 10 } })

    const first = store.getParent(subject)
    expect(first).not.toBeNull()
    expect(store.getParent(subject)).toBe(first)
    expect(store.getParents()[0]).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
  })
})
