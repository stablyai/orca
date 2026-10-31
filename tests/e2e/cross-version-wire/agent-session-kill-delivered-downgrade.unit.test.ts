import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { agentSessionConversationView } from '../../../src/shared/agent-session-conversation-view'
import {
  agentSessionLeaseOwnerVerdict,
  agentSessionLeasePossiblyWriting
} from '../../../src/shared/agent-session-lease-adjudication'
import { agentSessionRecordFixture } from '../../../src/shared/agent-session-record.test-fixture'
import { agentModelCatalogReleasedOwner } from '../../../src/main/native-chat/agent-model-catalog/agent-model-catalog-snapshot'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { structuredAgentSessionLiveFence } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-current-work'
import { upgradeStoredStructuredAgentSessionOwnerExitEvidence } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-lease-release'
import { turnVerdictFromDeathEvidence } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-stale-turn-verdict'
import { releaseStoredAgentSessionOwnerAfterSurfaceClose } from '../../../src/main/runtime/agent-session/ownership/agent-session-surface-release-transition'
import { loadAgentSessionStoreRows } from '../../../src/main/runtime/agent-session-record-rows'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../../src/main/runtime/agent-session-record-store-test-harness'
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
test(`${RELEASE_REF} keeps a stopped chat readable through restart, resume and evidence replacement`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-kill-downgrade-'))
  try {
    const live = agentSessionRecordFixture()
    const sessionId = live.sessionId
    await seedTestAgentSessionRecordStore(directory, { records: [live] })
    const current = await openTestAgentSessionRecordStore(directory)
    // Seed the host's already-attached owner; the Stop itself uses the real transition and commit.
    await current.transitionHandoff(sessionId, () => live)
    await releaseStoredAgentSessionOwnerAfterSurfaceClose(current, {
      sessionId,
      expectedFence: 7,
      now: 40_000,
      deathEvidenceKind: 'kill-delivered',
      exitReason: 'killed'
    })
    // Include optional proof facts in the same production serialization contract.
    await current.transitionHandoff(sessionId, (record) => ({
      ...record,
      lease: {
        ...record.lease,
        deathEvidence: record.lease.deathEvidence && {
          ...record.lease.deathEvidence,
          lastProvenAliveAt: 35_000,
          runtimeEnd: 'quit'
        }
      }
    }))
    const evidence = current.getRecord(sessionId)?.lease.deathEvidence
    expect(evidence).toEqual({
      kind: 'kill-delivered',
      detail: 'killed',
      observedAt: 40_000,
      ownerFence: 7,
      lastProvenAliveAt: 35_000,
      runtimeEnd: 'quit'
    })
    const db = openTestJournalHostDatabase(directory).db
    const saved = db
      .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
      .get(sessionId)
    if (typeof saved?.record_json !== 'string') {
      throw new Error('the current store must save the chat')
    }
    const raw = JSON.parse(saved.record_json)
    expect(raw.lease.deathEvidence).toEqual({ ...evidence, kind: 'pid-absent', delivery: 'kill' })

    const checkout = await materializeReleaseCheckout(RELEASE_REF)
    const [records, rows, drafts, restart, adjudication, transitions, views] = await Promise.all([
      importReleaseCheckoutModule(checkout, 'src/shared/agent-session-record.ts'),
      importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-record-rows.ts'),
      importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-store-draft.ts'),
      importReleaseCheckoutModule(
        checkout,
        'src/main/runtime/agent-session/ownership/agent-session-restart-lease-transitions.ts'
      ),
      importReleaseCheckoutModule(checkout, 'src/shared/agent-session-lease-adjudication.ts'),
      importReleaseCheckoutModule(
        checkout,
        'src/main/runtime/agent-session/ownership/agent-session-lease-transitions.ts'
      ),
      importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-store-state.ts')
    ])
    expect(exported(records, 'isPersistedAgentSessionRecord')(raw)).toBe(true)
    const loaded = exported(rows, 'loadAgentSessionStoreRows')(db)
    expect(storeMaps(loaded).unreadableRecords.size).toBe(0)
    const old = oldRecord(storeMaps(loaded).records.get(sessionId))
    expect(
      exported(
        adjudication,
        'adjudicateAgentSessionRestart'
      )({
        lease: old.lease,
        probe: { outcome: 'indeterminate', reason: 'no child after restart' },
        observedAt: 50_000
      })
    ).toMatchObject({ disposition: 'free' })
    const reconciled = oldRecord(
      exported(
        restart,
        'applyAgentSessionRestartAdjudication'
      )({
        record: old,
        probe: { outcome: 'indeterminate', reason: 'no child after restart' },
        now: 50_000
      })
    )
    expect(reconciled.lease).toMatchObject({
      unreconciled: false,
      runtimeFence: 8,
      deathEvidence: raw.lease.deathEvidence
    })
    const writeOld = (record: unknown) => {
      const before = exported(rows, 'loadAgentSessionStoreRows')(db)
      const draft = exported(drafts, 'draftAgentSessionStoreState')(before)
      storeMaps(draft).records.set(sessionId, record)
      exported(rows, 'writeAgentSessionStoreRows')(
        db,
        exported(drafts, 'agentSessionStoreDraftRowWrites')(before, draft)
      )
      return draft
    }
    const oldState = writeOld(reconciled)
    expect(exported(views, 'listAgentSessionConversations')(oldState)).toMatchObject([
      { sessionId, currentFence: 8 }
    ])
    expect(exported(views, 'getAgentSessionConversation')(oldState, sessionId)).toMatchObject({
      sessionId,
      ownerObservation: { unreconciled: false, claimStatus: 'released' }
    })
    expect(exported(views, 'requireWritableAgentSessionRecord')(oldState, sessionId)).toEqual(
      reconciled
    )

    const upgraded = await openTestAgentSessionRecordStore(directory)
    const restored = upgraded.getRecord(sessionId)
    if (!restored) {
      throw new Error('the upgraded chat must remain readable')
    }
    expect(restored.lease.deathEvidence).toEqual(evidence)
    expect(restored.lease.runtimeFence).toBe(8)
    const conversation = agentSessionConversationView(restored)
    expect(agentSessionLeaseOwnerVerdict(restored.lease)).toBe('exited')
    expect(agentSessionLeasePossiblyWriting(restored.lease)).toBe(false)
    expect(structuredAgentSessionLiveFence({ record: conversation })).toBeNull()
    expect(agentModelCatalogReleasedOwner(conversation)).toBe(true)
    expect(turnVerdictFromDeathEvidence(restored.lease.deathEvidence, 7)).toEqual({
      state: 'interrupted',
      completedAt: 35_000
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
    expect(loadAgentSessionStoreRows(db).records.get(sessionId)?.lease).toMatchObject({
      runtimeFence: 8,
      deathEvidence: { ...evidence, kind: 'exit-observed', observedAt: 60_000 }
    })

    // Starting again in the old build ends the previous proof, including its marker.
    const reservation = exported(
      transitions,
      'reserveAgentSessionOwner'
    )({
      record: reconciled,
      expectedFence: 8,
      probe: { outcome: 'pid-absent' },
      reservation: {
        spawnToken: 'next-owner',
        claimKeyId: 'key-1',
        handoffOperationId: null,
        leaseTtlMs: 30_000,
        now: 70_000
      }
    })
    if (typeof reservation !== 'object' || reservation === null || !('record' in reservation)) {
      throw new Error('the old build must reserve a successor')
    }
    const reserved = oldRecord(reservation.record)
    writeOld(reserved)
    expect(loadAgentSessionStoreRows(db).records.get(sessionId)?.lease).toMatchObject({
      runtimeFence: 9,
      claimStatus: 'reserved',
      deathEvidence: null
    })
    const replaced = oldRecord(
      exported(
        restart,
        'applyAgentSessionRestartAdjudication'
      )({
        record: reserved,
        probe: { outcome: 'reservation-unused' },
        now: 80_000
      })
    )
    writeOld(replaced)
    const replacement = loadAgentSessionStoreRows(db).records.get(sessionId)?.lease.deathEvidence
    expect(replacement).toEqual({
      kind: 'pid-absent',
      detail: 'reservation never spawned',
      observedAt: 80_000,
      ownerFence: 9
    })
    expect(replaced.lease.deathEvidence).not.toHaveProperty('delivery')
  } finally {
    await closeTestJournalHostDatabase(directory)
    await rm(directory, { recursive: true, force: true })
  }
}, 300_000)
