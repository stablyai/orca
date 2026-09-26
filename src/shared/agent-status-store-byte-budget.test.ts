import { expect, it } from 'vitest'
import { createAgentStatusStore } from './agent-status-store'
import { AGENT_STATUS_STORE_LIMITS } from './agent-status-store-contract'
import {
  deserializeAgentStatusStoreSnapshot,
  serializeAgentStatusStoreSnapshot
} from './agent-status-store-persistence'
import { makeStructuredAgentStatusSubject } from './agent-status-subject'

it('rejects cumulative snapshot overflow atomically even when each mutation fits', () => {
  const subject = makeStructuredAgentStatusSubject(
    { executionHostId: 'local', wslDistro: null, workspaceId: 'folder-a', workspaceKind: 'folder' },
    'session_11111111-1111-4111-8111-111111111111'
  )
  const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject } })).not.toBeNull()
  const batch = (offset: number) => ({
    facts: Array.from({ length: 1024 }, (_, index) => ({
      subject,
      key: `fact-${offset + index}`,
      value: 'x'.repeat(4096)
    }))
  })
  for (const offset of [0, 1024, 2048]) {
    expect(store.applyMutation(batch(offset))).not.toBeNull()
  }
  const before = store.getSnapshot()
  expect(store.applyMutation(batch(3072))).toBeNull()
  expect(store.getSnapshot()).toEqual(before)
  expect(serializeAgentStatusStoreSnapshot(before).length).toBeLessThan(
    AGENT_STATUS_STORE_LIMITS.serializedBytes
  )
})

it('can deserialize a dense valid snapshot within the declared record and byte budgets', () => {
  const subject = makeStructuredAgentStatusSubject(
    { executionHostId: 'local', wslDistro: null, workspaceId: 'folder-a', workspaceKind: 'folder' },
    'session_11111111-1111-4111-8111-111111111111'
  )
  const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  expect(
    store.applySnapshot({
      version: 1,
      epoch: 'persisted',
      revision: 1,
      parents: [{ subject, revision: 1 }],
      children: Array.from({ length: 8192 }, (_, index) => ({
        childWorkId: `child-${index}`,
        parent: subject,
        provider: 'claude',
        kind: 'agent',
        state: 'working',
        membership: 'live',
        firstObservedAt: 10,
        observedAt: 10,
        stoppable: false,
        invocation: { invocationId: 'invocation-1', generation: 1 },
        provenance: { source: 'structured-session', producerId: 'journal' },
        revision: 1
      })),
      aliases: [],
      facts: Array.from({ length: 8192 }, (_, index) => ({
        subject,
        key: `fact-${index}`,
        value: true,
        revision: 1
      })),
      tombstones: []
    })
  ).toBe(true)
  const snapshot = store.getSnapshot()
  expect(deserializeAgentStatusStoreSnapshot(serializeAgentStatusStoreSnapshot(snapshot))).toEqual(
    snapshot
  )
})
