import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../src/shared/agent-session/journal/agent-session-journal-identity'
import { codexProviderHandle } from '../../../src/shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { parseAgentJournalItemKey } from '../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { JournalOutcomeSweeper } from '../../../src/main/native-chat/agent-session-journal/journal-outcome-cleanup'
import { restoreJournal } from '../../../src/main/native-chat/agent-session-journal/journal-open'
import { sweepAttachmentClaims } from '../../../src/main/native-chat/agent-session-attachments/agent-session-attachment-claim-sweep'
import { AgentSessionAttachmentStore } from '../../../src/main/native-chat/agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../../../src/main/native-chat/agent-session-attachments/agent-session-attachment-references'
import Database from '../../../src/main/sqlite/sync-database'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  releaseModuleExport,
  resolveRecentStableReleaseRefs
} from './release-checkout'

// Older builds that share one chat database with this build, run from their own pinned sources.
// A main build that writes only outcome format 1 (pinned by commit; no release shipped format 1
// alone) keeps its chat through this build's background cleanup, keeps writing and rewinding it,
// and this build reads every state the older build left; once this build writes format 2 into the
// chat, or starts a new one, the format-1 build refuses it as a newer Orca's and changes no byte.
// The previous two stable releases open and write a database whose attachment claims this build
// migrated to never-reused identities, and this build carries on after them.
const SUITE_TIMEOUT_MS = 240_000
const FORMAT_1_WRITER = 'a65467d6e23b979e1ec00728aa75635c10a77e6b'
const JOURNAL = 'src/main/native-chat/agent-session-journal'
const ATTACHMENTS = 'src/main/native-chat/agent-session-attachments'
const DATABASE_FILE = 'agent-session-journal.db'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-older-build',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

type OlderJournal = {
  epoch: string
  snapshot: () => { items: { itemId: string }[] }
  itemBody: (itemId: string) => unknown
  appendItem: (identity: unknown, body: unknown, options: unknown) => Promise<unknown>
  appendClaimingAttachments: (
    identity: unknown,
    body: unknown,
    options: unknown
  ) => Promise<unknown>
  replaceEpochItems: (reason: string, fence: number, items: unknown[]) => Promise<unknown>
}
type OlderBuild = {
  label: string
  open: () => Promise<OlderJournal>
  /** The build's own native connection, for its own claim writers. */
  db: () => Database.Database
  prune: (db: Database.Database, facts: { root: string; recordedSessionIds: Set<string> }) => number
  close: () => Promise<void>
}

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-journal-older-builds-'))
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  rmSync(directory, { recursive: true, force: true })
})

async function olderBuild(ref: string): Promise<OlderBuild> {
  const checkout = await materializeReleaseCheckout(ref)
  const support = await importReleaseCheckoutModule(
    checkout,
    `${JOURNAL}/journal-host-database-test-support.ts`
  )
  const claims = await importReleaseCheckoutModule(
    checkout,
    `${ATTACHMENTS}/agent-session-attachment-claims.ts`
  )
  const opener = releaseModuleExport<
    () => {
      open: (options: { identity: unknown; stateDirectory: string }) => Promise<OlderJournal>
      closeAll: () => Promise<void>
    }
  >(support, 'createTrackedJournalOpener')()
  const openDatabase = releaseModuleExport<(stateDirectory: string) => { db: Database.Database }>(
    support,
    'openTestJournalHostDatabase'
  )
  const closeDatabase = releaseModuleExport<(stateDirectory: string) => Promise<void> | void>(
    support,
    'closeTestJournalHostDatabase'
  )
  return {
    label: ref,
    open: () => opener.open({ identity: IDENTITY, stateDirectory: directory }),
    db: () => openDatabase(directory).db,
    prune: releaseModuleExport(claims, 'pruneAgentSessionAttachmentClaims'),
    close: async () => {
      await opener.closeAll()
      await closeDatabase(directory)
    }
  }
}

const statusOf = (ordinal: number) => ({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal
})
const appendOptions = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

/** Every item as a build shows it: key and body, in order. */
const itemsOf = (journal: Pick<OlderJournal, 'snapshot' | 'itemBody'>) =>
  journal.snapshot().items.map(({ itemId }) => ({ itemId, body: journal.itemBody(itemId) }))

/** A rewind keeping `keep` of the chat's items, as both builds' replacement takes them. */
async function rewind(journal: OlderJournal, keep: number): Promise<void> {
  const kept = journal
    .snapshot()
    .items.slice(0, keep)
    .map(({ itemId }) => ({
      identity: parseAgentJournalItemKey(itemId),
      body: journal.itemBody(itemId),
      ownerFence: 1
    }))
  await journal.replaceEpochItems('handle_forked', 1, kept)
}

/** This build's journal over the same files; every open after a close is a cold read. */
async function current<T>(run: (journal: OlderJournal) => Promise<T>): Promise<T> {
  const opener = createTrackedJournalOpener()
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this build's journal implements every method the older-build shape names.
    return await run(
      (await opener.open({
        identity: IDENTITY,
        stateDirectory: directory
      })) as unknown as OlderJournal
    )
  } finally {
    await opener.closeAll()
  }
}

/** This build's complete scheduled cleanup pass: retired generations, compaction and reclaim. */
async function cleanup(): Promise<{ removed: number }> {
  const database = await openTestJournalHostDatabase(directory)
  const count = () =>
    Number(database.db.prepare('SELECT COUNT(*) AS n FROM journal_outcomes').get()?.n)
  const before = count()
  const errors: unknown[] = []
  const sweeper = new JournalOutcomeSweeper({
    database: () => database,
    delay: async () => {},
    onError: (error) => errors.push(error)
  })
  try {
    await sweeper.pass()
  } finally {
    sweeper.stop()
  }
  expect(errors).toEqual([])
  const removed = before - count()
  await closeTestJournalHostDatabases()
  return { removed }
}

/** The database file and its log by content; an empty log, which a clean close removes, holds nothing. */
function databaseBytes(): Record<string, string> {
  return Object.fromEntries(
    [DATABASE_FILE, `${DATABASE_FILE}-wal`]
      .filter(
        (file) => existsSync(join(directory, file)) && statSync(join(directory, file)).size > 0
      )
      .map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(directory, file)))
          .digest('hex')
      ])
  )
}

async function refusedBy(build: OlderBuild): Promise<void> {
  const before = databaseBytes()
  try {
    const failure = await build.open().then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toMatchObject(SAVED_BY_NEWER_ORCA)
  } finally {
    await build.close()
  }
  expect(databaseBytes()).toEqual(before)
}

describe('a format-1 chat the format-1 build keeps writing around this build', () => {
  it(
    'survives cleanup, cold reads, the older writer continuing and two successive rewinds, then is refused once mixed',
    async () => {
      const older = await olderBuild(FORMAT_1_WRITER)
      // The format-1 build writes the chat, revising one item so cleanup has superseded records.
      let written: ReturnType<typeof itemsOf>
      try {
        const journal = await older.open()
        for (let ordinal = 0; ordinal < 3; ordinal++) {
          await journal.appendItem(
            statusOf(ordinal),
            { kind: 'status', text: `item ${ordinal}` },
            appendOptions
          )
        }
        for (let revision = 0; revision < 40; revision++) {
          await journal.appendItem(
            statusOf(1),
            { kind: 'status', text: `revised ${revision}` },
            appendOptions
          )
        }
        written = itemsOf(journal)
      } finally {
        await older.close()
      }
      expect(written).toHaveLength(3)

      // This build's background pass deletes only superseded records; both builds read it as written.
      expect((await cleanup()).removed).toBeGreaterThan(0)
      expect(await current(async (journal) => itemsOf(journal))).toEqual(written)
      const formats = () => {
        const db = new Database(join(directory, DATABASE_FILE), { readonly: true })
        try {
          return db.prepare('SELECT DISTINCT format FROM journal_outcomes ORDER BY format').all()
        } finally {
          db.close()
        }
      }
      // Reading wrote nothing: the chat is still format 1 only.
      expect(formats()).toEqual([{ format: 1 }])

      // The older writer continues from the cleaned chat: a cold read, a write, two rewinds.
      let continued: ReturnType<typeof itemsOf>
      try {
        const journal = await older.open()
        expect(itemsOf(journal)).toEqual(written)
        await journal.appendItem(
          statusOf(3),
          { kind: 'status', text: 'after cleanup' },
          appendOptions
        )
        await rewind(journal, 3)
        const once = itemsOf(journal)
        expect(once).toEqual(written)
        await journal.appendItem(
          statusOf(4),
          { kind: 'status', text: 'after one rewind' },
          appendOptions
        )
        await rewind(journal, 2)
        continued = itemsOf(journal)
        expect(continued).toEqual(written.slice(0, 2))
      } finally {
        await older.close()
      }
      expect(formats()).toEqual([{ format: 1 }])
      try {
        expect(itemsOf(await older.open())).toEqual(continued)
      } finally {
        await older.close()
      }

      // This build cleans the rewound chat and reads it as the older build left it.
      await cleanup()
      expect(await current(async (journal) => itemsOf(journal))).toEqual(continued)

      // This build writes and rewinds twice: the chat now mixes formats 1 and 2.
      const mixed = await current(async (journal) => {
        await journal.appendItem(statusOf(5), { kind: 'status', text: 'this build' }, appendOptions)
        await rewind(journal, 3)
        await journal.appendItem(
          statusOf(6),
          { kind: 'status', text: 'this build again' },
          appendOptions
        )
        await rewind(journal, 4)
        return itemsOf(journal)
      })
      expect(mixed.map(({ itemId }) => itemId)).toEqual([
        ...continued.map(({ itemId }) => itemId),
        expect.stringMatching(/:5$/),
        expect.stringMatching(/:6$/)
      ])
      expect(formats()).toEqual([{ format: 1 }, { format: 2 }])
      await refusedBy(older)
      await cleanup()
      expect(await current(async (journal) => itemsOf(journal))).toEqual(mixed)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'refuses a chat this build started, as a newer Orca’s, leaving every byte',
    async () => {
      const written = await current(async (journal) => {
        for (let ordinal = 0; ordinal < 3; ordinal++) {
          await journal.appendItem(
            statusOf(ordinal),
            { kind: 'status', text: `item ${ordinal}` },
            appendOptions
          )
        }
        return itemsOf(journal)
      })
      await cleanup()
      await refusedBy(await olderBuild(FORMAT_1_WRITER))
      expect(await current(async (journal) => itemsOf(journal))).toEqual(written)
    },
    SUITE_TIMEOUT_MS
  )
})

type Claim = { claim_id: number; upload_id: string; session_id: string; claimed_at: number }

function claims(): Claim[] {
  const db = new Database(join(directory, DATABASE_FILE), { readonly: true })
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the columns are selected by name below.
    return db
      .prepare(
        'SELECT claim_id, upload_id, session_id, claimed_at FROM agent_session_attachment_claims ORDER BY claim_id'
      )
      .all() as Claim[]
  } finally {
    db.close()
  }
}

function upload(uploadId: string): string {
  const dir = join(agentSessionAttachmentStoreRoot(directory), uploadId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'shot.png'), 'bytes')
  return join(dir, 'shot.png')
}

/** Upload directories are named by UUID; the last digit tells these apart. */
const UPLOAD = {
  release1: '00000000-0000-4000-8000-000000000001',
  release2: '00000000-0000-4000-8000-000000000002',
  release3: '00000000-0000-4000-8000-000000000003',
  current1: '00000000-0000-4000-8000-000000000004',
  current2: '00000000-0000-4000-8000-000000000005'
} as const
const RELEASE_UPLOADS = new Set<string>([UPLOAD.release1, UPLOAD.release2, UPLOAD.release3])

const imageMessage = (path: string) => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'image-ref', path }]
})

describe('the previous two stable releases over a database this build migrated', () => {
  const releases = resolveRecentStableReleaseRefs(2)

  it.each(releases.map((ref, index) => [index === 0 ? 'the newest' : 'the previous', ref]))(
    '%s stable release (%s) reads, writes, claims and prunes, and this build carries on with claim identities above every earlier one',
    async (_which, ref) => {
      const release = await olderBuild(ref)
      // The release writes a chat and two attachment claims in its own claim table.
      let releaseItems: ReturnType<typeof itemsOf>
      try {
        const journal = await release.open()
        await journal.appendItem(statusOf(0), { kind: 'status', text: 'release' }, appendOptions)
        await journal.appendClaimingAttachments(
          { provider: 'orca', clientMessageId: 'release-1' },
          imageMessage(upload(UPLOAD.release1)),
          appendOptions
        )
        await journal.appendClaimingAttachments(
          { provider: 'orca', clientMessageId: 'release-2' },
          imageMessage(upload(UPLOAD.release2)),
          appendOptions
        )
        releaseItems = itemsOf(journal)
      } finally {
        await release.close()
      }
      const legacy = new Database(join(directory, DATABASE_FILE), { readonly: true })
      const legacyClaims = legacy
        .prepare(
          'SELECT upload_id, session_id, claimed_at FROM agent_session_attachment_claims ORDER BY upload_id'
        )
        .all()
      expect(
        legacy
          .prepare('PRAGMA table_info(agent_session_attachment_claims)')
          .all()
          .map((c) => c.name)
      ).toEqual(['upload_id', 'session_id', 'claimed_at'])
      legacy.close()
      expect(legacyClaims).toHaveLength(2)

      // This build migrates at open, keeping every claim value, then claims through its own writer.
      const upgraded = await current(async (journal) => {
        expect(itemsOf(journal)).toEqual(releaseItems)
        await journal.appendClaimingAttachments(
          { provider: 'orca', clientMessageId: 'current-1' },
          imageMessage(upload(UPLOAD.current1)),
          appendOptions
        )
        return itemsOf(journal)
      })
      const migrated = claims()
      expect(
        migrated
          .filter(({ upload_id }) => RELEASE_UPLOADS.has(upload_id))
          .map(({ claim_id: _id, ...value }) => value)
      ).toEqual(legacyClaims)
      expect(migrated.at(-1)).toMatchObject({ upload_id: UPLOAD.current1 })
      const migratedMaximum = Math.max(...migrated.map(({ claim_id }) => claim_id))

      // The release opens the migrated database and the chat this build wrote, keeps writing,
      // claims through its own writer, then prunes its newest claim, whose upload is gone.
      let releaseClaim: Claim | undefined
      let continued: ReturnType<typeof itemsOf>
      try {
        const journal = await release.open()
        expect(itemsOf(journal)).toEqual(upgraded)
        await journal.appendClaimingAttachments(
          { provider: 'orca', clientMessageId: 'release-3' },
          imageMessage(upload(UPLOAD.release3)),
          appendOptions
        )
        continued = itemsOf(journal)
        releaseClaim = claims().find(({ upload_id }) => upload_id === UPLOAD.release3)
        rmSync(join(agentSessionAttachmentStoreRoot(directory), UPLOAD.release3), {
          recursive: true
        })
        expect(
          release.prune(release.db(), {
            root: agentSessionAttachmentStoreRoot(directory),
            recordedSessionIds: new Set([IDENTITY.sessionId])
          })
        ).toBe(1)
      } finally {
        await release.close()
      }
      expect(continued).toHaveLength(upgraded.length + 1)
      // The release's insert drew the next never-used identity from the migrated allocator.
      expect(releaseClaim?.claim_id).toBe(migratedMaximum + 1)
      const afterRelease = claims()
      expect(afterRelease).toEqual(migrated)

      // Upgraded again: the chat reads whole, and a new claim's identity exceeds every earlier one,
      // including the release's pruned maximum, which a reused rowid would have taken again.
      await current(async (journal) => {
        expect(itemsOf(journal)).toEqual(continued)
        await journal.appendClaimingAttachments(
          { provider: 'orca', clientMessageId: 'current-2' },
          imageMessage(upload(UPLOAD.current2)),
          appendOptions
        )
      })
      const final = claims()
      expect(final.at(-1)).toMatchObject({ upload_id: UPLOAD.current2 })
      expect(final.at(-1)!.claim_id).toBe(releaseClaim!.claim_id + 1)
      expect(final.slice(0, -1)).toEqual(afterRelease)
      const database = await openTestJournalHostDatabase(directory)
      const store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(directory), {
        hasSession: () => true
      })
      rmSync(join(agentSessionAttachmentStoreRoot(directory), UPLOAD.release2), {
        recursive: true
      })
      await sweepAttachmentClaims(store, {
        database: () => database,
        recordedSessionIds: () => new Set([IDENTITY.sessionId])
      })
      await closeTestJournalHostDatabases()
      expect(claims()).toEqual(final.filter(({ upload_id }) => upload_id !== UPLOAD.release2))
      const restored = new Database(join(directory, DATABASE_FILE), { readonly: true })
      try {
        expect(restoreJournal(restored, IDENTITY.sessionId)).toMatchObject({
          newer: null,
          damage: null
        })
      } finally {
        restored.close()
      }
    },
    SUITE_TIMEOUT_MS
  )
})
