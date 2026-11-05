import { failNextNativeJournalStatement } from '../../../src/main/native-chat/agent-session-journal/journal-native-test-instrumentation'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionJournalIdentity,
  AgentSessionJournalProviderHandle
} from '../../../src/shared/agent-session/journal/agent-session-journal-identity'
import { codexProviderHandle } from '../../../src/shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import Database from '../../../src/main/sqlite/sync-database'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { journalOutcomeSource } from '../../../src/main/native-chat/agent-session-journal/journal-outcome-format'
import { restoreJournal } from '../../../src/main/native-chat/agent-session-journal/journal-open'
import type { JournalStoredRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-table'
import type { AgentSessionJournal } from '../../../src/main/native-chat/agent-session-journal/journal-store'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  releaseModuleExport,
  resolveBaselineReleaseRef
} from './release-checkout'

// A chat this build has written, new or an existing one whose input rows an older build wrote, is
// refused by each of the two last releases before outcome storage as a newer Orca's, which leaves
// every byte as it was; a build from before that reason opens it read-only, as it does any newer
// row, and changes no saved row (it only adds a table of its own). The existing chat's input rows
// stay byte for byte throughout, and this build reads the whole chat again afterwards.
const SUITE_TIMEOUT_MS = 180_000
// A main build sharing this database and schema; the releases in the window are probed as well.
// v1.4.246 shipped outcome storage and reads these chats itself, so the refusing window ends before it.
const REFUSING_RELEASE_REFS = ['v1.4.245', 'v1.4.244'] as const
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

const appendStatus = (journal: Pick<AgentSessionJournal, 'appendItem'>, ordinal: number) =>
  journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
    { kind: 'status', text: `item ${ordinal}` },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )

/** A chat this build writes: new, or existing with three input rows of items an older build wrote
 * before this build's first write. Returns that prefix as stored. */
async function savedChat(kind: 'new' | 'existing'): Promise<JournalStoredRow[]> {
  let prefix: JournalStoredRow[] = []
  if (kind === 'existing') {
    const older = createTrackedJournalOpener({ legacyInputs: true })
    const journal = await older.open({ identity: IDENTITY, stateDirectory: directory })
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      await appendStatus(journal, ordinal)
    }
    await older.closeAll()
    prefix = liveTestJournalRows(
      (await openTestJournalHostDatabase(directory)).db,
      IDENTITY.sessionId
    )
    expect(prefix).toHaveLength(4)
  }
  const journals = createTrackedJournalOpener()
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
  for (let ordinal = 3; ordinal < 6; ordinal++) {
    await appendStatus(journal, ordinal)
  }
  await journals.closeAll()
  const database = await openTestJournalHostDatabase(directory)
  expect(journalOutcomeSource(database.db, IDENTITY.sessionId, journal.epoch)).toMatchObject({
    prefix: prefix.length
  })
  const rows = liveTestJournalRows(database.db, IDENTITY.sessionId)
  expect(rows.slice(0, prefix.length)).toEqual(prefix)
  // One appended marker, after the prefix, where outcome records begin.
  expect(rows.map((row) => row.seq)).toEqual([...prefix.map((row) => row.seq), prefix.length + 1])
  await closeTestJournalHostDatabase(directory)
  return prefix
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

describe('a chat this build wrote, opened by a shipped build', () => {
  it.each([
    ['new', 'the last release before outcome storage'],
    ['existing', 'the last release before outcome storage'],
    ['new', 'the release before it'],
    ['existing', 'the release before it'],
    ['new', 'the writable baseline'],
    ['existing', 'the writable baseline']
  ] as const)(
    'keeps a %s chat from %s, leaving every byte as it was, and reads whole again after',
    async (kind, build) => {
      const prefix = await savedChat(kind)
      const before = databaseBytes()
      const saved = savedContent()
      expect(before['agent-session-journal.db']).toBeDefined()
      const inWindow = build !== 'the writable baseline'
      const checkout = await materializeReleaseCheckout(
        build === 'the last release before outcome storage'
          ? REFUSING_RELEASE_REFS[0]
          : inWindow
            ? REFUSING_RELEASE_REFS[1]
            : WRITABLE_BASELINE_REF
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
        if (inWindow) {
          const failure = await older.open({ identity: IDENTITY, stateDirectory: directory }).then(
            () => null,
            (error: unknown) => error
          )
          expect(failure).toMatchObject(SAVED_BY_NEWER_ORCA)
        } else {
          const opened = await older.open({ identity: OLDER_IDENTITY, stateDirectory: directory })
          // It latches read-only at the marker, having read only the rows before it.
          expect(opened.snapshot().items).toHaveLength(Math.max(prefix.length - 1, 0))
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
      if (inWindow) {
        expect(databaseBytes()).toEqual(before)
      } else {
        const after = savedContent()
        expect(
          [...saved].filter(([name, content]) => !isDeepStrictEqual(after.get(name), content))
        ).toEqual([])
      }
      // Upgraded again, this build reads the prefix and its records, the rows still as they were.
      const database = await openTestJournalHostDatabase(directory)
      try {
        const reopened = restoreJournal(database.db, IDENTITY.sessionId)
        expect(reopened).toMatchObject({ newer: null, damage: null })
        expect(reopened?.state.items.size).toBe(kind === 'existing' ? 6 : 3)
        const rows = liveTestJournalRows(database.db, IDENTITY.sessionId)
        expect(rows.slice(0, prefix.length)).toEqual(prefix)
      } finally {
        await closeTestJournalHostDatabase(directory)
      }
    },
    SUITE_TIMEOUT_MS
  )
})

// Checks out and loads the newest release's own journal code, which takes well past the default.
it(
  'leaves an existing chat whose first write from this build failed as it was, so the newest release opens and writes it',
  async () => {
    const older = createTrackedJournalOpener({ legacyInputs: true })
    const seeded = await older.open({ identity: IDENTITY, stateDirectory: directory })
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      await appendStatus(seeded, ordinal)
    }
    await older.closeAll()
    const prefix = liveTestJournalRows(
      (await openTestJournalHostDatabase(directory)).db,
      IDENTITY.sessionId
    )
    await closeTestJournalHostDatabase(directory)

    const journals = createTrackedJournalOpener()
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    const database = await openTestJournalHostDatabase(directory)
    // The first write fails after its marker is in: at a record, then at COMMIT.
    database.db.exec(`CREATE TRIGGER failure BEFORE INSERT ON journal_outcomes
      BEGIN SELECT RAISE(ABORT, 'record failure'); END`)
    await expect(appendStatus(journal, 3)).rejects.toThrow('record failure')
    database.db.exec('DROP TRIGGER failure')
    await failNextNativeJournalStatement(database, 'COMMIT', 'commit failure')
    await expect(appendStatus(journal, 4)).rejects.toThrow('commit failure')
    expect(journalOutcomeSource(database.db, IDENTITY.sessionId, journal.epoch)).toBeNull()
    expect(
      database.db.prepare('SELECT COUNT(*) AS n FROM journal_outcome_generations').get()?.n
    ).toBe(0)
    expect(liveTestJournalRows(database.db, IDENTITY.sessionId)).toEqual(prefix)
    await journals.closeAll()

    const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
    const support = await importReleaseCheckoutModule(
      checkout,
      `${JOURNAL}/journal-host-database-test-support.ts`
    )
    const release = releaseModuleExport<() => ReleasedOpener>(
      support,
      'createTrackedJournalOpener'
    )()
    try {
      const opened = await release.open({ identity: IDENTITY, stateDirectory: directory })
      expect(opened.snapshot().items).toHaveLength(3)
      await opened.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 9 },
        { kind: 'status', text: 'from the release' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    } finally {
      await release.closeAll()
      releaseModuleExport<(stateDirectory: string) => void>(
        support,
        'closeTestJournalHostDatabase'
      )(directory)
    }
    const reopened = await openTestJournalHostDatabase(directory)
    try {
      expect(restoreJournal(reopened.db, IDENTITY.sessionId)?.state.items.size).toBe(4)
      expect(liveTestJournalRows(reopened.db, IDENTITY.sessionId).slice(0, prefix.length)).toEqual(
        prefix
      )
    } finally {
      await closeTestJournalHostDatabase(directory)
    }
  },
  SUITE_TIMEOUT_MS
)
