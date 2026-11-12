import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  type TrackedJournalOpener
} from '../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { restoreJournal } from '../../../src/main/native-chat/agent-session-journal/replay/journal-open'
import { JOURNAL_PREFIX_ORDINAL } from '../../../src/main/native-chat/agent-session-journal/outcomes/journal-outcome-codec'
import { journalOutcomeSource } from '../../../src/main/native-chat/agent-session-journal/outcomes/journal-outcome-format'
import type { AgentJournalSnapshot } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { parseJournalRow } from '../../../src/main/native-chat/agent-session-journal/durable-rows/journal-row-schema'
import {
  readJournalSessionEpoch,
  type JournalStoredRow
} from '../../../src/main/native-chat/agent-session-journal/durable-rows/journal-row-table'
import { JournalWriteProjection } from '../../../src/main/native-chat/agent-session-journal/writing/journal-write-projection'
import { readPublishedQueuedMessages } from '../../../src/main/native-chat/agent-session-wire/delivery/structured-agent-session-queued-publication'
import { resolveBaselineReleaseRef } from './release-checkout'
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

// The two releases before outcome storage, and the oldest release whose chat database this build still
// reads, writes a Claude and a Codex chat through its own writers. This build admits every row as
// written, opens the chat as that release had it, then edits a queued card (its first write, over
// a key the old rows hold), sends, and rewinds, which saves the kept chat again in this build's
// form. Every commit restores to the live chat. What this build does after the open is checked on
// its own result, never against a release, so main stays free to change it.
const SUITE_TIMEOUT_MS = 180_000
// v1.4.246 shipped outcome storage, so its chats hold no rows to upgrade; the writers pin the two
// releases before it, and the newest release stays the reader this build must match.
const RELEASES = {
  'the last release before outcome storage': () => 'v1.4.245',
  'the release before it': () => 'v1.4.244',
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
  cards: [...journal.queuedMessages.displayState().queue.cards.values()].sort(
    (a, b) => a.position - b.position
  )
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
  prefix?: JournalStoredRow[]
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
      await editReleasedCard(journal)
      if (prefix) {
        // The release's rows stay byte for byte; one marker follows them, where records begin.
        const database = openTestJournalHostDatabase(stateDirectory)
        const rows = liveTestJournalRows(database.db, options.identity.sessionId)
        expect(rows.slice(0, prefix.length)).toEqual(prefix)
        expect(rows).toHaveLength(prefix.length + 1)
        expect(
          journalOutcomeSource(database.db, options.identity.sessionId, journal.epoch)?.prefix
        ).toBe(prefix.length)
      }
      await sendAfterUpgrade(journal)
      const sent = view(journal)
      expect(sent.snapshot.submissions).toContainEqual(
        expect.objectContaining({ clientMessageId: 'after-upgrade', dispatchState: 'accepted' })
      )
      const beforeRewind = journal.cursor()
      const database = openTestJournalHostDatabase(stateDirectory)
      const physicalEpoch = readJournalSessionEpoch(database.db, options.identity.sessionId)
      expect(physicalEpoch).not.toBeNull()
      await rewindReleasedChat(journal, new Set(opened.snapshot.items.map((item) => item.itemId)))
      expect(journal.epoch).toMatch(/^context-v1:/)
      expect(journal.epoch).not.toBe(beforeRewind.epoch)
      expect(readJournalSessionEpoch(database.db, options.identity.sessionId)).toBe(physicalEpoch)
      expect(journal.readSince(beforeRewind)).toEqual({ ok: false, reset: 'epoch_changed' })
      const seen = view(journal)
      // The rewind keeps every message the release wrote and every card not taken back, the edit
      // included.
      expect(kept(seen.snapshot.items)).toEqual(kept(opened.snapshot.items))
      const active = seen.cards.filter((card) => card.state !== 'withdrawn')
      expect(active.map((card) => card.messageId)).toEqual(
        opened.cards.filter((card) => card.state !== 'withdrawn').map((card) => card.messageId)
      )
      expect(active).toHaveLength(1)
      expect(active).toEqual(sent.cards.filter((card) => card.state !== 'withdrawn'))
      expect(seen.cards.filter((card) => card.state === 'withdrawn')).toEqual(
        opened.cards.filter((card) => card.state === 'withdrawn')
      )
      expect(readPublishedQueuedMessages(journal).map((card) => card.messageId)).toEqual(['card-2'])
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
    .then((journal) => {
      expect(readPublishedQueuedMessages(journal).map((card) => card.messageId)).toEqual(['card-2'])
      return view(journal)
    })
    .finally(() => opener.closeAll())
  expect(reopened).toEqual(carried.seen)
  return carried
}

describe('a chat a shipped release wrote, carried on by this build', () => {
  it.each([
    ['the last release before outcome storage', 'claude'],
    ['the last release before outcome storage', 'codex'],
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
        expect(rows.filter((row) => !parseJournalRow(row.rowJson).ok)).toEqual([])
        // Anti-vacuous: the release wrote every row kind a chat holds (cards in their own table
        // before they moved into the rows).
        const kinds = new Set(rows.map((row) => JSON.parse(row.rowJson).kind))
        expect([...kinds].filter((kind) => kind !== 'queue').sort()).toEqual(
          ['dispatch', 'epoch', 'item', 'lifecycle-batch', 'submission', 'tombstone'].sort()
        )
        expect(kinds.has('queue')).toBe(build !== 'the oldest release with this chat database')
        expect(restoreJournal(database.db, identity.sessionId)).toMatchObject({
          newer: null,
          damage: null
        })
        await closeTestJournalHostDatabase(directory)
        cpSync(directory, shipped, { recursive: true })

        const ours = await carryOn(createTrackedJournalOpener(), agent, directory, written, rows)
        if (build !== 'the oldest release with this chat database') {
          expect(
            ours.seen.cards
              .filter((card) => card.state === 'withdrawn')
              .map((card) => card.messageId)
          ).toEqual(['card-1'])
          // A release in the window wrote the shapes this build reads, so it opens as written,
          // and the edit records the card the old rows hold in its place among them.
          expect(releaseWritten(ours.opened)).toMatchObject(releaseWritten(written))
          const edits = openTestJournalHostDatabase(directory)
            .db.prepare(`SELECT ordinal FROM journal_outcomes
            WHERE field = 'queue.cards' AND entry_key = '"card-2"'`)
            .all()
          expect(edits).toContainEqual({ ordinal: JOURNAL_PREFIX_ORDINAL })
          await closeTestJournalHostDatabase(directory)
        }
        // This build opens the chat as the newest release does.
        const newest = await releasedJournalOpener(resolveBaselineReleaseRef())
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
