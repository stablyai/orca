import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION
} from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity,
  AgentSessionJournalProviderHandle
} from '../../../src/shared/agent-session/journal/agent-session-journal-identity'
import { codexProviderHandle } from '../../../src/shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import Database from '../../../src/main/sqlite/sync-database'
import type { AgentSessionJournal } from '../../../src/main/native-chat/agent-session-journal/journal-store'
import { readTestJournalItems } from '../../../src/main/native-chat/agent-session-journal/journal-observation.test-support'
import { journalDatabasePath } from '../../../src/main/native-chat/agent-session-journal/database/journal-host-database'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA,
  seedLegacyTestJournal
} from '../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  releaseModuleExport
} from './release-checkout'
import { agentJournalItemKey } from '../../../src/shared/agent-session/journal/agent-session-journal-item-key'

const JOURNAL = 'src/main/native-chat/agent-session-journal'
// Pin a main build sharing this database/schema for writable downgrade; move to the first release that ships it.
const WRITABLE_BASELINE_REF = '3727100cc9dbcea6201f8a3e506676a3c4b53b18'

const EPOCH = 'epoch-saved-before-conversion'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-downgrade',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

/** The identity as builds before the neutral provider handle took it. */
type OlderJournalIdentity = Omit<AgentSessionJournalIdentity, 'providerHandle'> & {
  providerHandle: AgentSessionJournalProviderHandle
}

const OLDER_IDENTITY: OlderJournalIdentity = {
  ...IDENTITY,
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

type OlderJournal = {
  isReadOnly: boolean
  snapshot: () => { items: { itemId: string }[] }
  appendItem: (...args: [AgentJournalItemIdentity, unknown, unknown]) => Promise<unknown>
}

type OlderOpener = {
  open: (options: {
    identity: OlderJournalIdentity
    stateDirectory: string
  }) => Promise<OlderJournal>
  closeAll: () => Promise<void>
}

function storedRows(directory: string): string[] {
  const db = new Database(journalDatabasePath(directory), { readonly: true })
  try {
    return liveTestJournalRows(db, IDENTITY.sessionId).map((row) => row.rowJson)
  } finally {
    db.close()
  }
}

const SCOPE = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

/** A chat an older build saved, before this build first converts it; returns the row writer. */
function savedBeforeConversion(directory: string) {
  const database = openTestJournalHostDatabase(directory)
  seedLegacyTestJournal(database, { identity: IDENTITY, mintEpoch: () => EPOCH, now: () => 1_000 })
  return (seq: number, fields: Record<string, unknown>): string => {
    const row = JSON.stringify({
      // A version the older build reads, so it meets the kind rather than a newer version.
      v: AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION,
      epoch: EPOCH,
      seq,
      fence: 1,
      ts: 1_000 + seq,
      ...fields
    })
    insertTestJournalRowJson(database.db, IDENTITY.sessionId, seq, row)
    return row
  }
}

const statusRow = (ordinal: number, text: string) => ({
  kind: 'item',
  itemId: agentJournalItemKey(item(ordinal)),
  revision: 1,
  turnScope: AGENT_JOURNAL_THREAD_SCOPE,
  body: { kind: 'status', text }
})

// Conversion is one-way: a downgraded build sees the chat as converted, and its later writes
// are not carried forward, so the upgraded chat is this build's own.
test("an older build opens and appends to the chat as converted; upgraded again, the chat and its Stop pause are this build's", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-stop-event-writable-downgrade-'))
  const journals = createTrackedJournalOpener()
  const savedIds = async (journal: AgentSessionJournal) =>
    (await readTestJournalItems(journal)).map((entry) => entry.itemId)
  const pauses = async (journal: AgentSessionJournal) =>
    (await journal.queuedMessages.pauses()).map((pause) => pause.reason)
  try {
    savedBeforeConversion(directory)(2, statusRow(0, 'before the upgrade'))
    await closeTestJournalHostDatabase(directory)
    const converted = storedRows(directory)

    const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    await journal.appendItem(item(1), { kind: 'status', text: 'before the Stop' }, SCOPE)
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1', caller: 'client-1' }, 1)
    await journal.appendItem(item(2), { kind: 'status', text: 'after the Stop' }, SCOPE)
    const wrote = { cursor: journal.cursor(), items: await savedIds(journal) }
    expect(wrote.items).toEqual([0, 1, 2].map((ordinal) => agentJournalItemKey(item(ordinal))))
    expect(await pauses(journal)).toEqual(['stopped'])
    await journals.closeAll()
    expect(storedRows(directory)).toEqual(converted)

    const checkout = await materializeReleaseCheckout(WRITABLE_BASELINE_REF)
    const support = await importReleaseCheckoutModule(
      checkout,
      `${JOURNAL}/journal-host-database-test-support.ts`
    )
    const older = releaseModuleExport<() => OlderOpener>(support, 'createTrackedJournalOpener')()
    try {
      const downgraded = await older.open({ identity: OLDER_IDENTITY, stateDirectory: directory })
      expect(downgraded.isReadOnly).toBe(false)
      expect(downgraded.snapshot().items.map((entry) => entry.itemId)).toEqual([
        agentJournalItemKey(item(0))
      ])
      await downgraded.appendItem(item(3), { kind: 'status', text: 'the older build' }, SCOPE)
    } finally {
      await older.closeAll()
    }
    const rowsAfter = storedRows(directory)
    expect(rowsAfter.slice(0, converted.length)).toEqual(converted)
    expect(rowsAfter).toHaveLength(converted.length + 1)

    const upgraded = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    expect(upgraded.cursor()).toEqual(wrote.cursor)
    expect(await savedIds(upgraded)).toEqual(wrote.items)
    expect(await pauses(upgraded)).toEqual(['stopped'])
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)

// Write a new Stop row kind only after supported readers know it, or bump v; earlier hosts truncate unknown kinds.
// Move the pinned baseline once a released reader preserves them.
test("this build keeps a newer build's row kind and refuses the load; a build before it deletes it", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-newer-kind-downgrade-'))
  const journals = createTrackedJournalOpener()
  const newerKinds = () => storedRows(directory).filter((row) => row.includes('"future-mark"'))
  try {
    // A saved chat with an item, then a newer row, before this build first converts it.
    const save = savedBeforeConversion(directory)
    save(2, statusRow(0, 'before'))
    const newer = save(3, { kind: 'future-mark', payload: { said: 'by a newer build' } })
    await closeTestJournalHostDatabase(directory)
    const rowsBefore = storedRows(directory)

    await expect(
      journals.open({ identity: IDENTITY, stateDirectory: directory })
    ).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
    await journals.closeAll()
    expect(storedRows(directory)).toEqual(rowsBefore)
    expect(newerKinds()).toEqual([newer])

    const checkout = await materializeReleaseCheckout(WRITABLE_BASELINE_REF)
    const support = await importReleaseCheckoutModule(
      checkout,
      `${JOURNAL}/journal-host-database-test-support.ts`
    )
    const older = releaseModuleExport<() => OlderOpener>(support, 'createTrackedJournalOpener')()
    try {
      await older.open({ identity: OLDER_IDENTITY, stateDirectory: directory })
    } finally {
      await older.closeAll()
    }
    expect(newerKinds()).toEqual([])
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)
