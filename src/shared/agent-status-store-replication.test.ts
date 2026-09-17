import { describe, expect, it } from 'vitest'

import {
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  type AgentStatusIpcPayload
} from './agent-status-types'
import {
  AgentStatusStorePublisher,
  type AgentStatusStoreSourceMutation
} from './agent-status-store-publisher'
import {
  AGENT_STATUS_STORE_FRAME_ENTRIES_MAX,
  AgentStatusStoreReplica,
  isAgentStatusStoreFrame,
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

  it('resets the cursor when a new-owner resnapshot marker arrives', () => {
    const replica = new AgentStatusStoreReplica()
    replica.apply(snapshot({ rows: [row('a')], cursor: 7 }))

    expect(
      replica.apply({
        type: 'resnapshot-required',
        executionHostId: 'local',
        ownerEpoch: 'epoch-b',
        cursor: 2,
        reason: 'owner-restart'
      })
    ).toBe('resnapshot-required')
    expect(replica.getHostSnapshot('local')).toMatchObject({
      ownerEpoch: 'epoch-b',
      cursor: null,
      membershipConfirmed: false,
      rows: [row('a')]
    })
    expect(
      replica.apply(
        delta({
          ownerEpoch: 'epoch-b',
          previousCursor: 2,
          cursor: 3,
          changes: [{ type: 'drop', identity: { paneKey: 'a' } }]
        })
      )
    ).toBe('resnapshot-required')
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

    for (const listener of listeners) {
      listener({ before: null, after: { paneKey: 'c' } })
    }
    expect(frames[1]).toEqual({
      type: 'delta',
      executionHostId: 'local',
      ownerEpoch: 'epoch-a',
      previousCursor: 2,
      cursor: 3,
      changes: [{ type: 'set', row: row('c') }]
    })
  })
})

describe('AgentStatusStoreReplica remote payload limits', () => {
  it('stores the normalizer output, not the raw wire row, from a snapshot', () => {
    const replica = new AgentStatusStoreReplica()
    const hostile: AgentStatusIpcPayload = {
      ...row('pane-a'),
      agentType: 'claude\nrogue',
      lastAssistantMessage: 'x'.repeat(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH + 5_000)
    }

    replica.apply(snapshot({ rows: [hostile] }))

    const [stored] = replica.getHostSnapshot('local').rows
    expect(stored.agentType).not.toContain('\n')
    expect(stored.agentType?.length).toBeLessThanOrEqual(AGENT_TYPE_MAX_LENGTH)
    expect(stored.lastAssistantMessage?.length).toBeLessThanOrEqual(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    )
  })

  it('stores the normalizer output for a delta set change', () => {
    const replica = new AgentStatusStoreReplica()
    replica.apply(snapshot({ rows: [] }))
    const hostile: AgentStatusIpcPayload = {
      ...row('pane-b'),
      agentType: 'codex\ninjected',
      lastAssistantMessage: 'y'.repeat(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH + 1)
    }

    replica.apply(delta({ changes: [{ type: 'set', row: hostile }] }))

    const stored = replica.getHostSnapshot('local').rows.find((r) => r.paneKey === 'pane-b')
    expect(stored?.agentType).not.toContain('\n')
    expect(stored?.lastAssistantMessage?.length).toBe(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH)
  })

  it('rejects a frame whose row or change count exceeds the entry ceiling', () => {
    const tooManyRows = Array.from({ length: AGENT_STATUS_STORE_FRAME_ENTRIES_MAX + 1 }, (_, i) =>
      row(`pane-${i}`)
    )
    expect(isAgentStatusStoreFrame(snapshot({ rows: tooManyRows }))).toBe(false)
    expect(
      isAgentStatusStoreFrame(
        delta({
          changes: tooManyRows.map((r) => ({ type: 'set' as const, row: r }))
        })
      )
    ).toBe(false)
  })

  it('still accepts a frame at the entry ceiling', () => {
    const atCeiling = Array.from({ length: AGENT_STATUS_STORE_FRAME_ENTRIES_MAX }, (_, i) =>
      row(`pane-${i}`)
    )
    expect(isAgentStatusStoreFrame(snapshot({ rows: atCeiling }))).toBe(true)
  })
})
