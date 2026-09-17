import { describe, expect, it } from 'vitest'

import type { AgentStatusIpcPayload } from './agent-status-types'
import {
  AgentStatusStorePublisher,
  type AgentStatusStoreSourceMutation
} from './agent-status-store-publisher'
import {
  AgentStatusStoreReplica,
  type AgentStatusStoreDelta,
  type AgentStatusStoreFrame,
  type AgentStatusStoreSnapshot
} from './agent-status-store-replication'

function row(
  paneKey: string,
  state: AgentStatusIpcPayload['state'] = 'working'
): AgentStatusIpcPayload {
  return {
    paneKey,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    state,
    prompt: ''
  }
}

function snapshot(overrides: Partial<AgentStatusStoreSnapshot> = {}): AgentStatusStoreSnapshot {
  return {
    type: 'snapshot',
    executionHostId: 'local',
    ownerEpoch: 'epoch-a',
    cursor: 0,
    complete: true,
    rows: [],
    ...overrides
  }
}

function delta(overrides: Partial<AgentStatusStoreDelta> = {}): AgentStatusStoreDelta {
  return {
    type: 'delta',
    executionHostId: 'local',
    ownerEpoch: 'epoch-a',
    previousCursor: 0,
    cursor: 1,
    changes: [],
    ...overrides
  }
}

describe('AgentStatusStoreReplica', () => {
  it('replaces membership only for the host that published a complete snapshot', () => {
    const replica = new AgentStatusStoreReplica()
    replica.apply(snapshot({ rows: [row('local-pane')] }))
    replica.apply(snapshot({ executionHostId: 'ssh:box', rows: [row('remote-pane')] }))
    replica.apply(snapshot({ rows: [], cursor: 1 }))

    expect(replica.getHostSnapshot('local').rows).toEqual([])
    expect(replica.getHostSnapshot('ssh:box').rows).toEqual([row('remote-pane')])
  })

  it('keeps omitted rows and unconfirms membership for an incomplete census', () => {
    const replica = new AgentStatusStoreReplica()
    replica.apply(snapshot({ rows: [row('a'), row('b')] }))
    replica.apply(snapshot({ cursor: 1, complete: false, rows: [row('a', 'waiting')] }))

    expect(replica.getHostSnapshot('local')).toMatchObject({
      membershipConfirmed: false,
      rows: [row('a', 'waiting'), row('b')]
    })
  })

  it('requires a resnapshot on a cursor gap without applying the delta', () => {
    const replica = new AgentStatusStoreReplica()
    replica.apply(snapshot({ rows: [row('a')] }))

    expect(
      replica.apply(
        delta({
          previousCursor: 1,
          cursor: 2,
          changes: [{ type: 'drop', identity: { paneKey: 'a' } }]
        })
      )
    ).toBe('resnapshot-required')
    expect(replica.getHostSnapshot('local')).toMatchObject({
      membershipConfirmed: false,
      rows: [row('a')]
    })
  })

  it('retains rows across owner restart until a complete replacement arrives', () => {
    const replica = new AgentStatusStoreReplica()
    replica.apply(snapshot({ rows: [row('a')] }))

    expect(
      replica.apply(
        delta({
          ownerEpoch: 'epoch-b',
          previousCursor: 0,
          cursor: 1,
          changes: [{ type: 'drop', identity: { paneKey: 'a' } }]
        })
      )
    ).toBe('resnapshot-required')
    expect(replica.getHostSnapshot('local')).toMatchObject({
      ownerEpoch: 'epoch-b',
      membershipConfirmed: false,
      rows: [row('a')]
    })
  })

  it('does not turn contact loss into row deletion or execution evidence', () => {
    const replica = new AgentStatusStoreReplica()
    replica.apply(snapshot({ rows: [row('question', 'waiting')] }))
    replica.setContact('local', 'unverifiable')

    expect(replica.getHostSnapshot('local')).toMatchObject({
      contact: 'unverifiable',
      membershipConfirmed: true,
      rows: [row('question', 'waiting')]
    })
  })
})

describe('AgentStatusStorePublisher', () => {
  it('buffers mutations before the snapshot boundary and publishes cursor-contiguous deltas', () => {
    const rows = new Map([['a', row('a')]])
    const listeners = new Set<(mutation: AgentStatusStoreSourceMutation) => void>()
    let mutateDuringSnapshot = true
    const publisher = new AgentStatusStorePublisher({
      executionHostId: 'local',
      ownerEpoch: 'epoch-a',
      source: {
        getSnapshot: () => {
          const result = [...rows.values()]
          if (mutateDuringSnapshot) {
            mutateDuringSnapshot = false
            rows.set('b', row('b'))
            for (const listener of listeners) {
              listener({ before: null, after: { paneKey: 'b' } })
            }
          }
          return result
        },
        getRowsForPane: (paneKey) => (rows.has(paneKey) ? [rows.get(paneKey)!] : []),
        subscribeMutations: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    })
    const frames: AgentStatusStoreFrame[] = []
    publisher.subscribe((value) => frames.push(value))

    expect(frames).toEqual([snapshot({ cursor: 1, rows: [row('a'), row('b')] })])
    rows.delete('a')
    for (const listener of listeners) {
      listener({ before: { paneKey: 'a' }, after: null })
    }
    expect(frames[1]).toEqual({
      type: 'delta',
      executionHostId: 'local',
      ownerEpoch: 'epoch-a',
      previousCursor: 1,
      cursor: 2,
      changes: [{ type: 'drop', identity: { paneKey: 'a' } }]
    })
  })

  it('fails closed to resnapshot-required when the census buffer overflows', () => {
    const listeners = new Set<(mutation: AgentStatusStoreSourceMutation) => void>()
    let first = true
    const publisher = new AgentStatusStorePublisher({
      executionHostId: 'local',
      ownerEpoch: 'epoch-a',
      bufferMax: 1,
      snapshotAttempts: 1,
      source: {
        getSnapshot: () => {
          if (first) {
            first = false
            for (const paneKey of ['a', 'b']) {
              for (const listener of listeners) {
                listener({ before: null, after: { paneKey } })
              }
            }
          }
          return []
        },
        getRowsForPane: (paneKey) => [row(paneKey)],
        subscribeMutations: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    })
    const frames: AgentStatusStoreFrame[] = []
    publisher.subscribe((value) => frames.push(value))

    expect(frames).toEqual([
      {
        type: 'resnapshot-required',
        executionHostId: 'local',
        ownerEpoch: 'epoch-a',
        cursor: 2,
        reason: 'overflow'
      }
    ])
  })
})
