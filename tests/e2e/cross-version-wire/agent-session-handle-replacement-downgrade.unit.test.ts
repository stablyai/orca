import { expect, test } from 'vitest'
import Database from '../../../src/main/sqlite/sync-database'
import {
  agentSessionProviderHandleKey,
  claudeProviderHandle,
  codexProviderHandle
} from '../../../src/shared/agent-session-provider-handle-encoding'
import {
  decodePersistedAgentSessionProviderHandleChain,
  encodePersistedAgentSessionProviderHandleChain,
  type AgentSessionProviderHandle,
  type AgentSessionProviderHandleLink
} from '../../../src/shared/agent-session-provider-handle'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../src/shared/agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from '../../../src/shared/agent-session-record-stored-form'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// A release before neutral handles: handles stored and held in their typed form.
const RELEASE_REF = 'v1.4.220'
// The main build that made handles neutral; no release has it yet. Move to the first that does.
const NEUTRAL_HANDLE_REF = 'e817b0e23747ffd6f16f2ddefea861950d82a3c0'

const acp = (nativeId: string): AgentSessionProviderHandle => ({
  transport: 'acp',
  agent: 'grok',
  nativeId
})

function link(
  linkId: string,
  nativeId: string,
  fence: number,
  extra: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId,
    handle: acp(nativeId),
    origin: 'created',
    mintedAtFence: fence,
    observedAt: fence * 1_000,
    ...extra
  }
}

/** The row a build that runs another agent's chats writes: its provider and handles are neutral. */
function neutralRow(chain: AgentSessionProviderHandleLink[]): unknown {
  const head = chain.at(-1)
  const fixture = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      provenHandleLinkId: head?.linkId,
      runtimeFence: head?.mintedAtFence
    })
  )
  return JSON.parse(
    JSON.stringify({
      ...fixture,
      provider: 'grok',
      accountHome: { variable: 'GROK_HOME', path: '/home/user/.grok' },
      providerHandleChain: encodePersistedAgentSessionProviderHandleChain(chain)
    })
  )
}

const REOPENED = [link('l1', 's-1', 1), link('l2', 's-1', 2, { origin: 'resumed' })]
const REPLACED = [
  ...REOPENED,
  link('l3', 's-2', 3, {
    replaces: {
      key: agentSessionProviderHandleKey(acp('s-1')),
      reason: 'restore-failed',
      replacedAt: 3_000
    }
  })
]

function storeMaps(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('records' in value) ||
    !(value.records instanceof Map) ||
    !('unreadableRecords' in value) ||
    !(value.unreadableRecords instanceof Map)
  ) {
    throw new Error('old store must expose its readable and unreadable rows')
  }
  return value
}

function legacyRow(provider: 'claude' | 'codex') {
  const fixture = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId: `chat-${provider}` })
  )
  return encodeAgentSessionRecord({
    ...fixture,
    provider,
    accountHome:
      provider === 'claude'
        ? fixture.accountHome
        : { variable: 'CODEX_HOME', path: '/home/user/.codex' },
    providerHandleChain: [
      {
        ...fixture.providerHandleChain[0],
        handle:
          provider === 'claude'
            ? claudeProviderHandle('saved-claude', 'leaf-1')
            : codexProviderHandle('saved-codex')
      }
    ]
  })
}

// A replacement is stored as it is held, which older builds would refuse; it is safe only because
// the rows that can hold one are rows they already set aside. Claude and Codex chains refuse it.
test.each([RELEASE_REF, NEUTRAL_HANDLE_REF])(
  '%s preserves legacy rows and sets aside a replaced neutral row verbatim until re-upgrade',
  async (ref) => {
    const checkout = await materializeReleaseCheckout(ref)
    const records = await importReleaseCheckoutModule(
      checkout,
      'src/shared/agent-session-record.ts'
    )
    const isRecord = records.isPersistedAgentSessionRecord
    if (typeof isRecord !== 'function') {
      throw new Error(`${ref} exports no isPersistedAgentSessionRecord`)
    }
    expect(isRecord(neutralRow(REOPENED))).toBe(false)
    expect(isRecord(neutralRow(REPLACED))).toBe(false)

    const [rowModule, draftModule] = await Promise.all([
      importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-record-rows.ts'),
      importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-store-draft.ts')
    ])
    const loadRows = rowModule.loadAgentSessionStoreRows
    const writeRows = rowModule.writeAgentSessionStoreRows
    const draftState = draftModule.draftAgentSessionStoreState
    const rowWrites = draftModule.agentSessionStoreDraftRowWrites
    if (
      typeof loadRows !== 'function' ||
      typeof writeRows !== 'function' ||
      typeof draftState !== 'function' ||
      typeof rowWrites !== 'function'
    ) {
      throw new Error(`${ref} must expose the row load and write path`)
    }
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT);
        CREATE TABLE agent_session_operations (operation_key TEXT PRIMARY KEY, row_json TEXT);
        CREATE TABLE agent_session_retired_claim_keys (key_id TEXT PRIMARY KEY, retired_at INTEGER);
        CREATE TABLE agent_session_tabs (tab_id TEXT PRIMARY KEY, session_id TEXT, position INTEGER);
        CREATE TABLE agent_session_store_meta (key TEXT PRIMARY KEY, value TEXT);
      `)
      const insert = db.prepare('INSERT INTO agent_session_records VALUES (?, ?)')
      const legacyRows = [legacyRow('claude'), legacyRow('codex')]
      for (const row of legacyRows) {
        expect(isRecord(row)).toBe(true)
        insert.run(row.sessionId, JSON.stringify(row))
      }
      // Whitespace proves preservation of the stored bytes, not just the parsed value.
      const neutralJson = JSON.stringify(neutralRow(REPLACED), null, 2)
      insert.run('session-alpha-1', neutralJson)
      const loaded = storeMaps(loadRows(db, 'local'))
      expect([...loaded.records.keys()]).toEqual(['chat-claude', 'chat-codex'])
      expect(loaded.unreadableRecords.get('session-alpha-1')).toEqual({
        reason: 'current_shape_invalid',
        raw: JSON.parse(neutralJson)
      })
      const draft = storeMaps(draftState(loaded))
      for (const row of legacyRows) {
        const record: unknown = loaded.records.get(row.sessionId)
        if (typeof record !== 'object' || record === null || !('lease' in record)) {
          throw new Error(`${ref} must read the legacy row`)
        }
        const lease = record.lease
        if (typeof lease !== 'object' || lease === null) {
          throw new Error(`${ref} must preserve the legacy lease`)
        }
        // Re-derive the owner after load, forcing the old build's actual serialization path.
        draft.records.set(row.sessionId, { ...record, lease: { ...lease, unreconciled: false } })
      }
      const writes: unknown = rowWrites(loaded, draft)
      expect(writes).not.toBeNull()
      writeRows(db, writes)
      for (const row of legacyRows) {
        expect(
          db
            .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
            .get(row.sessionId)?.record_json
        ).toBe(JSON.stringify(row))
      }
      const preserved = db
        .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
        .get('session-alpha-1')?.record_json
      expect(preserved).toBe(neutralJson)
      if (typeof preserved !== 'string') {
        throw new Error('the neutral row must survive the old build')
      }
      const upgraded: unknown = JSON.parse(preserved)
      if (
        typeof upgraded !== 'object' ||
        upgraded === null ||
        !('providerHandleChain' in upgraded)
      ) {
        throw new Error('the preserved row must still contain its chain')
      }
      // The provider-neutral record reader lands in the consumer PR; this PR owns chain decoding.
      expect(decodePersistedAgentSessionProviderHandleChain(upgraded.providerHandleChain)).toEqual(
        REPLACED
      )
    } finally {
      db.close()
    }
  },
  300_000
)
