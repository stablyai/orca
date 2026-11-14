import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { agentSessionConversationView } from '../../../src/shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseOwnerVerdict,
  agentSessionLeasePossiblyWriting
} from '../../../src/shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import { agentSessionRecordFixture } from '../../../src/shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { agentModelCatalogReleasedOwner } from '../../../src/main/native-chat/agent-model-catalog/agent-model-catalog-snapshot'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { upgradeStoredStructuredAgentSessionOwnerExitEvidence } from '../../../src/main/native-chat/agent-session-wire/host/structured-agent-session-lease-release'
import { turnVerdictFromDeathEvidence } from '../../../src/main/native-chat/agent-session-wire/termination/structured-agent-session-stale-turn-verdict'
import { releaseStoredAgentSessionOwnerAfterSurfaceClose } from '../../../src/main/runtime/agent-session/ownership/agent-session-surface-release-transition'
import {
  closeTestAgentSessionDatabase,
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore,
  storedTestAgentSessionRecord
} from '../../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// The last release before Stop recorded a delivered kill.
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

function oldRecord(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('lease' in value) ||
    typeof value.lease !== 'object' ||
    value.lease === null ||
    !('deathEvidence' in value.lease)
  ) {
    throw new Error('the old build must expose the chat and its lease')
  }
  return { ...value, lease: value.lease }
}

// Materializing the historical source checkout and importing its modules can exceed the default timeout.
// Conversion is one-way: a downgraded build keeps the records as converted, and what it writes
// later is not carried forward, so the upgraded store keeps this build's records.
test(`${RELEASE_REF} keeps the converted records readable and writable; the upgraded store keeps this build's stopped chat`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-kill-downgrade-'))
  try {
    const live = agentSessionRecordFixture()
    const sessionId = live.sessionId
    // The chat as an older build saved it, before this build first converts the store.
    const legacy = openTestJournalHostDatabase(directory).db
    legacy
      .prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)')
      .run(sessionId, JSON.stringify(storedTestAgentSessionRecord(live)))
    const converted = String(
      legacy
        .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
        .get(sessionId)?.record_json
    )

    await closeTestJournalHostDatabase(directory)
    await openTestAgentSessionRecordStore(directory)
    // Admit this fixture's live owner after installation invalidates previously saved authority.
    await seedTestAgentSessionRecordStore(directory, { records: [live] })
    const current = await openTestAgentSessionRecordStore(directory, { mode: 'observe' })
    expect(current.getRecord(sessionId)?.lease.runtimeFence).toBe(7)
    await releaseStoredAgentSessionOwnerAfterSurfaceClose(current, {
      sessionId,
      expectedFence: 7,
      now: 40_000,
      deathEvidenceKind: 'kill-delivered',
      exitReason: 'killed'
    })
    const stopped = current.getRecord(sessionId)
    expect(stopped?.lease.deathEvidence).toEqual({
      kind: 'kill-delivered',
      detail: 'killed',
      observedAt: 40_000,
      ownerFence: 7
    })
    await closeTestAgentSessionDatabase(directory)

    const checkout = await materializeReleaseCheckout(RELEASE_REF)
    const [rows, drafts, restart] = await Promise.all([
      importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-record-rows.ts'),
      importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-store-draft.ts'),
      importReleaseCheckoutModule(
        checkout,
        'src/main/runtime/agent-session/ownership/agent-session-restart-lease-transitions.ts'
      )
    ])
    // The older build reads the records as converted, without this build's Stop.
    const db = openTestJournalHostDatabase(directory).db
    expect(
      db
        .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
        .get(sessionId)?.record_json
    ).toBe(converted)
    const loaded = storeMaps(exported(rows, 'loadAgentSessionStoreRows')(db))
    expect(loaded.unreadableRecords.size).toBe(0)
    const old = oldRecord(loaded.records.get(sessionId))
    expect(old.lease).toMatchObject({ runtimeFence: 7, deathEvidence: null })
    // It writes its own restart reconciliation over them.
    const reconciled = oldRecord(
      exported(
        restart,
        'applyAgentSessionRestartAdjudication'
      )({
        record: old,
        probe: { outcome: 'pid-absent' },
        now: 50_000
      })
    )
    const before = exported(rows, 'loadAgentSessionStoreRows')(db)
    const draft = exported(drafts, 'draftAgentSessionStoreState')(before)
    storeMaps(draft).records.set(sessionId, reconciled)
    exported(rows, 'writeAgentSessionStoreRows')(
      db,
      exported(drafts, 'agentSessionStoreDraftRowWrites')(before, draft)
    )
    // Its loader holds every loaded lease unreconciled until that host proves ownership again.
    expect(
      oldRecord(storeMaps(exported(rows, 'loadAgentSessionStoreRows')(db)).records.get(sessionId))
    ).toEqual({ ...reconciled, lease: { ...reconciled.lease, unreconciled: true } })
    expect(
      db
        .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
        .get(sessionId)?.record_json
    ).not.toBe(converted)
    await closeTestJournalHostDatabase(directory)

    // Upgraded again over the older build's newer records: this build's stopped chat, unchanged.
    const upgraded = await openTestAgentSessionRecordStore(directory)
    const restored = upgraded.getRecord(sessionId)
    if (!restored) {
      throw new Error('the upgraded chat must remain readable')
    }
    // Opening the store is a restart: loaded leases stay unreconciled until ownership is proved.
    expect(restored).toEqual({ ...stopped, lease: { ...stopped?.lease, unreconciled: true } })
    const conversation = agentSessionConversationView(restored)
    expect(agentSessionLeaseOwnerVerdict(restored.lease)).toBe('exited')
    expect(agentSessionLeasePossiblyWriting(restored.lease)).toBe(false)
    expect(agentModelCatalogReleasedOwner(conversation)).toBe(true)
    expect(turnVerdictFromDeathEvidence(restored.lease.deathEvidence, 7)).toMatchObject({
      state: 'interrupted'
    })
    await upgraded.reconcileOnRestart({
      sessionId,
      probe: async () => ({ outcome: 'exit-observed' }),
      now: 60_000
    })
    await upgradeStoredStructuredAgentSessionOwnerExitEvidence(
      upgraded,
      {
        type: 'ended',
        sessionId,
        fence: 7,
        acquisitionGeneration: 'stopped-writer',
        cause: 'requested-close',
        reason: 'late exit',
        observedAt: 60_000
      },
      61_000
    )
    expect(upgraded.getRecord(sessionId)?.lease.deathEvidence).toMatchObject({
      kind: 'exit-observed',
      detail: 'killed',
      observedAt: 60_000,
      ownerFence: 7
    })
  } finally {
    await closeTestJournalHostDatabase(directory)
    await rm(directory, { recursive: true, force: true })
  }
}, 300_000)
