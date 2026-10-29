import { expect, test } from 'vitest'
import Database from '../../../src/main/sqlite/sync-database'
import { loadAgentSessionStoreRows } from '../../../src/main/runtime/agent-session-record-rows'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../src/shared/agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from '../../../src/shared/agent-session-record-stored-form'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// The last release before Stop recorded a delivered kill; it knows three death kinds.
const RELEASE_REF = 'v1.4.244'

type OldStoreMaps = {
  records: Map<unknown, unknown>
  unreadableRecords: Map<unknown, unknown>
}

function exported(module: Record<string, unknown>, name: string): (...args: unknown[]) => unknown {
  const value = module[name]
  if (typeof value !== 'function') {
    throw new Error(`${RELEASE_REF} exports no ${name}`)
  }
  return (...args) => value(...args)
}

function storeMaps(value: unknown): OldStoreMaps {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('records' in value) ||
    !(value.records instanceof Map) ||
    !('unreadableRecords' in value) ||
    !(value.unreadableRecords instanceof Map)
  ) {
    throw new Error(`${RELEASE_REF} store must expose its readable and unreadable rows`)
  }
  return { records: value.records, unreadableRecords: value.unreadableRecords }
}

test(`${RELEASE_REF} keeps a chat stopped by a delivered kill readable, and the kill survives its rewrite`, async () => {
  const evidence = { detail: 'killed', observedAt: 40_000, ownerFence: 7 } as const
  const killed = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      runtimeFence: 8,
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null,
      deathEvidence: { kind: 'kill-delivered', ...evidence }
    })
  )
  const checkout = await materializeReleaseCheckout(RELEASE_REF)
  const [records, rows, drafts] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/shared/agent-session-record.ts'),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-record-rows.ts'),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-store-draft.ts')
  ])
  const row = JSON.parse(JSON.stringify(encodeAgentSessionRecord(killed)))
  expect(exported(records, 'isPersistedAgentSessionRecord')(row)).toBe(true)

  const db = new Database(':memory:')
  try {
    db.exec(`
        CREATE TABLE agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT);
        CREATE TABLE agent_session_operations (operation_key TEXT PRIMARY KEY, row_json TEXT);
        CREATE TABLE agent_session_retired_claim_keys (key_id TEXT PRIMARY KEY, retired_at INTEGER);
        CREATE TABLE agent_session_tabs (tab_id TEXT PRIMARY KEY, session_id TEXT, position INTEGER);
        CREATE TABLE agent_session_store_meta (key TEXT PRIMARY KEY, value TEXT);
      `)
    db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(
      killed.sessionId,
      JSON.stringify(row)
    )
    const loaded = exported(rows, 'loadAgentSessionStoreRows')(db)
    expect(storeMaps(loaded).unreadableRecords.size).toBe(0)
    const old = storeMaps(loaded).records.get(killed.sessionId)
    if (
      typeof old !== 'object' ||
      old === null ||
      !('lease' in old) ||
      typeof old.lease !== 'object' ||
      old.lease === null
    ) {
      throw new Error(`${RELEASE_REF} must read the chat`)
    }
    expect(old.lease).toMatchObject({ deathEvidence: { kind: 'pid-absent', ...evidence } })
    // Force the old build's own serialization of the row, as any later write would.
    const draft = exported(drafts, 'draftAgentSessionStoreState')(loaded)
    storeMaps(draft).records.set(killed.sessionId, {
      ...old,
      lease: { ...old.lease, unreconciled: false },
      updatedAt: killed.updatedAt + 1
    })
    exported(rows, 'writeAgentSessionStoreRows')(
      db,
      exported(drafts, 'agentSessionStoreDraftRowWrites')(loaded, draft)
    )

    const upgraded = loadAgentSessionStoreRows(db).records.get(killed.sessionId)
    expect(upgraded?.lease.deathEvidence).toEqual({ kind: 'kill-delivered', ...evidence })
    expect(upgraded?.lease.runtimeFence).toBe(8)
  } finally {
    db.close()
  }
}, 300_000)
