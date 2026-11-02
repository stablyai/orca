import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  readTestJournalOutcomes,
  type TrackedJournalOpener
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { restoreJournal } from '../../../src/main/native-chat/agent-session-journal/journal-open'
import { JOURNAL_PREFIX_ORDINAL } from '../../../src/main/native-chat/agent-session-journal/journal-outcome-codec'
import {
  JOURNAL_OUTCOME_MARKER_VERSION,
  journalOutcomeSource,
  type JournalOutcomeSource
} from '../../../src/main/native-chat/agent-session-journal/journal-outcome-format'
import type { AgentJournalSnapshot } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { parseJournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import type { JournalStoredRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-table'
import { JournalWriteProjection } from '../../../src/main/native-chat/agent-session-journal/journal-write-projection'
import { resolveRecentStableReleaseRefs } from './release-checkout'
import {
  editReleasedCard,
  rewindReleasedChat,
  sendAfterUpgrade,
  type ContinuedJournal
} from './released-chat-continuation'
import {
  identityOf,
  releasedJournalOpener,
  writeReleasedChat,
  type Agent
} from './released-chat-writers'

// Each release in the downgrade window, and the oldest release whose chat database this build still
// reads, writes a Claude and a Codex chat through its own writers. This build admits every row as
// written, opens the chat as that release had it, then edits a queued card (its first write, over
// a key the old rows hold), sends, and rewinds, which saves the kept chat again in this build's
// form. Every commit restores to the live chat. What this build does after the open is checked on
// its own result, never against a release, so main stays free to change it.
const SUITE_TIMEOUT_MS = 180_000
const RELEASES = {
  'the newest release': () => resolveRecentStableReleaseRefs(2)[0]!,
  'the release before it': () => resolveRecentStableReleaseRefs(2)[1]!,
  // The first release with one chat database per host (schema 3, the oldest this build opens);
  // earlier releases kept a file per chat, which nothing reads any more. It never changes.
  'the oldest release with this chat database': () => 'v1.4.219'
} as const
type Written = Awaited<ReturnType<typeof writeReleasedChat>>

beforeEach(() => {
  JournalWriteProjection.verifyEachCommit = true
})
afterEach(() => {
  JournalWriteProjection.verifyEachCommit = false
})

const view = (journal: ContinuedJournal) => ({
  snapshot: journal.snapshot(),
  cards: [...journal.queuedMessages.list()]
})

/** What the release wrote: its items, sends and cards, in order. Fields a later build adds to them
 * are not compared (`toMatchObject`), so main may add one; a changed value or order still fails. */
const releaseWritten = ({
  snapshot,
  cards
}: {
  snapshot: AgentJournalSnapshot
  cards: unknown[]
}) => ({
  items: snapshot.items,
  submissions: snapshot.submissions,
  cards
})

const kept = (items: ReturnType<ContinuedJournal['snapshot']>['items']) =>
  items.map(({ itemId, body }) => ({ itemId, body }))

/** The chat as `opener`'s build opens it, over a copy so the original stays as the release left it. */
async function openedBy(opener: TrackedJournalOpener, agent: Agent, stateDirectory: string) {
  return opener
    .open({ identity: identityOf(agent), stateDirectory })
    .then(view)
    .finally(() => opener.closeAll())
}

/** Opens the chat, edits, sends and rewinds it, then reopens it; checks what the user sees. */
async function carryOn(
  opener: TrackedJournalOpener,
  agent: Agent,
  stateDirectory: string,
  written: Written,
  storage: { rows: JournalStoredRow[]; source: JournalOutcomeSource | null }
) {
  const options = {
    identity: identityOf(agent),
    stateDirectory,
    now: written.now,
    mintEpoch: () => 'epoch-rewound'
  }
  const carried = await opener
    .open(options)
    .then(async (journal) => {
      const opened = view(journal)
      const database = openTestJournalHostDatabase(stateDirectory)
      const cardOrdinal = database.db.prepare(`SELECT ordinal FROM journal_outcomes
        WHERE generation = ? AND field = 'queue.cards' AND entry_key = '"card-2"'
        ORDER BY seq DESC LIMIT 1`)
      const ordinal = storage.source
        ? cardOrdinal.get(storage.source.generation)?.ordinal
        : undefined
      if (storage.source) {
        expect(ordinal).toEqual(expect.any(String))
      }
      const outcomes = readTestJournalOutcomes(database.db, options.identity.sessionId)
      await editReleasedCard(journal)
      const rows = liveTestJournalRows(database.db, options.identity.sessionId)
      const source = journalOutcomeSource(database.db, options.identity.sessionId, journal.epoch)
      if (!source) {
        throw new Error('the card edit wrote no journal outcome source')
      }
      expect(rows.slice(0, storage.rows.length)).toEqual(storage.rows)
      if (storage.source) {
        expect(
          readTestJournalOutcomes(database.db, options.identity.sessionId).slice(0, outcomes.length)
        ).toEqual(outcomes)
        expect(cardOrdinal.get(source.generation)?.ordinal).toBe(ordinal)
        expect(rows).toEqual(storage.rows)
        expect(source).toMatchObject({
          generation: storage.source.generation,
          prefix: storage.source.prefix
        })
        expect(source.through).toBeGreaterThan(storage.source.through)
      } else {
        // The first outcome write appends its marker after the release's frozen input rows.
        expect(rows).toHaveLength(storage.rows.length + 1)
        expect(source.prefix).toBe(storage.rows.length)
      }
      await sendAfterUpgrade(journal)
      const sent = view(journal)
      expect(sent.snapshot.submissions).toContainEqual(
        expect.objectContaining({ clientMessageId: 'after-upgrade', dispatchState: 'accepted' })
      )
      await rewindReleasedChat(journal, new Set(opened.snapshot.items.map((item) => item.itemId)))
      expect(journal.epoch).toBe('epoch-rewound')
      const seen = view(journal)
      // The rewind keeps every message the release wrote and every card not taken back, the edit
      // included.
      expect(kept(seen.snapshot.items)).toEqual(kept(opened.snapshot.items))
      expect(seen.cards.map((card) => card.messageId)).toEqual(
        opened.cards.filter((card) => card.state !== 'withdrawn').map((card) => card.messageId)
      )
      expect(seen.cards).toHaveLength(1)
      for (const result of [sent, seen]) {
        expect(result.cards.find((card) => card.messageId === 'card-2')?.body.blocks).toEqual([
          { type: 'text', text: 'second, edited after the upgrade' }
        ])
      }
      return { opened, seen }
    })
    .finally(() => opener.closeAll())
  const reopened = await opener
    .open(options)
    .then(view)
    .finally(() => opener.closeAll())
  expect(reopened).toEqual(carried.seen)
  return carried
}

describe('a chat a shipped release wrote, carried on by this build', () => {
  it.each([
    ['the newest release', 'claude'],
    ['the newest release', 'codex'],
    ['the release before it', 'claude'],
    ['the release before it', 'codex'],
    ['the oldest release with this chat database', 'claude'],
    ['the oldest release with this chat database', 'codex']
  ] as const)(
    'admits every row %s wrote for a %s chat, opens it as the newest release does, then edits, sends and rewinds it',
    async (build, agent) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-released-chat-upgrade-'))
      const shipped = mkdtempSync(join(tmpdir(), 'orca-released-chat-shipped-'))
      const identity = identityOf(agent)
      try {
        const written = await writeReleasedChat(RELEASES[build](), agent, directory)
        // Anti-vacuous: the release's stream (beyond the two sends and the Stop turn), sends and
        // queue all reached the chat.
        expect(written.snapshot.items.length).toBeGreaterThan(3)
        expect(written.snapshot.submissions.map((entry) => entry.clientMessageId)).toEqual(
          expect.arrayContaining(['sent', 'refused'])
        )
        expect(written.cards).toHaveLength(2)

        const database = openTestJournalHostDatabase(directory)
        const rows = liveTestJournalRows(database.db, identity.sessionId)
        const source = journalOutcomeSource(
          database.db,
          identity.sessionId,
          written.snapshot.cursor.epoch
        )
        const input = source ? rows.slice(0, source.prefix) : rows
        expect(input.filter((row) => !parseJournalRow(row.rowJson).ok)).toEqual([])
        if (source) {
          expect(input).toHaveLength(source.prefix)
          expect(rows).toHaveLength(source.prefix + 1)
          const marker = rows[source.prefix]
          expect(JSON.parse(marker.rowJson)).toEqual({
            v: JOURNAL_OUTCOME_MARKER_VERSION,
            kind: 'outcomes',
            epoch: marker.epoch,
            seq: source.prefix + 1,
            ts: marker.ts
          })
          const outcomes = readTestJournalOutcomes(database.db, identity.sessionId)
          expect(outcomes.length).toBeGreaterThan(0)
          expect([...new Set(outcomes.map((outcome) => outcome.field))]).toEqual(
            expect.arrayContaining(['items', 'submissions', 'queue.cards'])
          )
        } else {
          // Input writers cover every row kind; the oldest kept cards in their own table.
          const kinds = new Set(rows.map((row) => JSON.parse(row.rowJson).kind))
          expect([...kinds].filter((kind) => kind !== 'queue').sort()).toEqual(
            ['dispatch', 'epoch', 'item', 'lifecycle-batch', 'submission', 'tombstone'].sort()
          )
          expect(kinds.has('queue')).toBe(build !== 'the oldest release with this chat database')
        }
        expect(restoreJournal(database.db, identity.sessionId)).toMatchObject({
          newer: null,
          damage: null
        })
        await closeTestJournalHostDatabase(directory)
        cpSync(directory, shipped, { recursive: true })

        const ours = await carryOn(createTrackedJournalOpener(), agent, directory, written, {
          rows,
          source
        })
        if (build !== 'the oldest release with this chat database') {
          // A release in the window wrote the shapes this build reads, so it opens as written,
          // and the edit records the card the old rows hold in its place among them.
          expect(releaseWritten(ours.opened)).toMatchObject(releaseWritten(written))
          const edits = openTestJournalHostDatabase(directory)
            .db.prepare(`SELECT ordinal FROM journal_outcomes
            WHERE field = 'queue.cards' AND entry_key = '"card-2"'`)
            .all()
          if (!source) {
            expect(edits).toContainEqual({ ordinal: JOURNAL_PREFIX_ORDINAL })
          }
          await closeTestJournalHostDatabase(directory)
        }
        // This build opens the chat as the newest release does.
        const newest = await releasedJournalOpener(RELEASES['the newest release']())
        expect(releaseWritten(ours.opened)).toMatchObject(
          releaseWritten(await openedBy(newest, agent, shipped))
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
        rmSync(shipped, { recursive: true, force: true })
      }
    },
    SUITE_TIMEOUT_MS
  )
})
