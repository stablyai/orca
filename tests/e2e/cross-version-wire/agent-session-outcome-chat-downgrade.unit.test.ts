import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity,
  type AgentSessionJournalProviderHandle
} from '../../../src/shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../src/shared/agent-session-provider-handle-encoding'
import Database from '../../../src/main/sqlite/sync-database'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { journalOutcomeSource } from '../../../src/main/native-chat/agent-session-journal/journal-outcome-format'
import { JournalMaintenanceRunner } from '../../../src/main/native-chat/agent-session-journal/journal-state-backfill'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  releaseModuleExport,
  resolveBaselineReleaseRef
} from './release-checkout'

// A chat saved as outcomes, whether new or converted, is refused by the newest release as a newer
// Orca's, which leaves every byte as it was; a build from before that reason opens it read-only, as
// it does any newer row, and changes no saved row (it only adds a table of its own).
const SUITE_TIMEOUT_MS = 180_000
// A main build sharing this database and schema; the newest release is probed as well.
const WRITABLE_BASELINE_REF = '3727100cc9dbcea6201f8a3e506676a3c4b53b18'
const JOURNAL = 'src/main/native-chat/agent-session-journal'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-outcome-chat',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
/** The identity as builds before the neutral provider handle took it. */
const OLDER_HANDLE: AgentSessionJournalProviderHandle = { kind: 'codex', threadId: 'thread-1' }
const OLDER_IDENTITY = { ...IDENTITY, providerHandle: OLDER_HANDLE }

type ReleasedJournal = {
  snapshot: () => { items: unknown[] }
  appendItem: (identity: unknown, body: unknown, options: unknown) => Promise<unknown>
}
type ReleasedOpener = {
  open: (options: { identity: unknown; stateDirectory: string }) => Promise<ReleasedJournal>
  closeAll: () => Promise<void>
}

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-outcome-chat-xv-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** A chat this build writes, saved as outcomes from its first row or converted from input rows. */
async function savedChat(kind: 'new' | 'converted'): Promise<void> {
  const journals = createTrackedJournalOpener({ legacyInputs: kind === 'converted' })
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
  for (let ordinal = 0; ordinal < 3; ordinal++) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
      { kind: 'status', text: `item ${ordinal}` },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await journals.closeAll()
  const database = openTestJournalHostDatabase(directory)
  if (kind === 'converted') {
    const runner = new JournalMaintenanceRunner({
      database: () => database,
      delay: async () => {}
    })
    await runner.pass()
    runner.stop()
  }
  expect(journalOutcomeSource(database.db, IDENTITY.sessionId, journal.epoch)).not.toBeNull()
  await closeTestJournalHostDatabase(directory)
}

/** The database file and its log, by content; SQLite's shared-memory index is not data. */
function databaseBytes(): Record<string, string> {
  return Object.fromEntries(
    ['agent-session-journal.db', 'agent-session-journal.db-wal']
      .filter((file) => existsSync(join(directory, file)))
      .map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(directory, file)))
          .digest('hex')
      ])
  )
}

/** Every table's schema and rows, in a stable order. */
function savedContent(): Map<string, unknown> {
  const db = new Database(join(directory, 'agent-session-journal.db'), { readonly: true })
  try {
    const content = new Map<string, unknown>()
    for (const { name, sql } of db
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()) {
      content.set(String(name), {
        sql,
        rows: db.prepare(`SELECT * FROM "${String(name)}" ORDER BY rowid`).all()
      })
    }
    return content
  } finally {
    db.close()
  }
}

describe('a chat saved as outcomes, opened by a shipped build', () => {
  it.each([
    ['new', 'the newest release'],
    ['converted', 'the newest release'],
    ['new', 'the writable baseline'],
    ['converted', 'the writable baseline']
  ] as const)(
    'keeps a %s outcome chat from %s, leaving every byte as it was',
    async (kind, build) => {
      await savedChat(kind)
      const before = databaseBytes()
      const saved = savedContent()
      expect(before['agent-session-journal.db']).toBeDefined()
      const newest = build === 'the newest release'
      const checkout = await materializeReleaseCheckout(
        newest ? resolveBaselineReleaseRef() : WRITABLE_BASELINE_REF
      )
      const support = await importReleaseCheckoutModule(
        checkout,
        `${JOURNAL}/journal-host-database-test-support.ts`
      )
      const older = releaseModuleExport<() => ReleasedOpener>(
        support,
        'createTrackedJournalOpener'
      )()
      const close = releaseModuleExport<(stateDirectory: string) => void>(
        support,
        'closeTestJournalHostDatabase'
      )
      try {
        if (newest) {
          const failure = await older.open({ identity: IDENTITY, stateDirectory: directory }).then(
            () => null,
            (error: unknown) => error
          )
          expect(failure).toMatchObject(SAVED_BY_NEWER_ORCA)
        } else {
          const opened = await older.open({ identity: OLDER_IDENTITY, stateDirectory: directory })
          expect(opened.snapshot().items).toEqual([])
          await expect(
            opened.appendItem(
              { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 9 },
              { kind: 'status', text: 'from the older build' },
              { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
            )
          ).rejects.toMatchObject({ code: 'journal_read_only' })
        }
      } finally {
        await older.closeAll()
        close(directory)
      }
      if (newest) {
        expect(databaseBytes()).toEqual(before)
      } else {
        const after = savedContent()
        expect(
          [...saved].filter(([name, content]) => !isDeepStrictEqual(after.get(name), content))
        ).toEqual([])
      }
    },
    SUITE_TIMEOUT_MS
  )
})
