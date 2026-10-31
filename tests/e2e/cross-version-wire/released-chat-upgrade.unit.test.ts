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
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { restoreJournal } from '../../../src/main/native-chat/agent-session-journal/journal-open'
import { JOURNAL_PREFIX_ORDINAL } from '../../../src/main/native-chat/agent-session-journal/journal-outcome-codec'
import { journalOutcomeSource } from '../../../src/main/native-chat/agent-session-journal/journal-outcome-format'
import { parseJournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import type { JournalStoredRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-table'
import { JournalWriteProjection } from '../../../src/main/native-chat/agent-session-journal/journal-write-projection'
import {
  resolveOldestStableReleaseRefWith,
  resolveRecentStableReleaseRefs
} from './release-checkout'
import {
  editReleasedCard,
  rewindReleasedChat,
  sendAfterUpgrade
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
// form. Every commit restores to the live chat, and the result equals the newest release's after
// the same steps.
const SUITE_TIMEOUT_MS = 180_000
const HOST_DATABASE = 'src/main/native-chat/agent-session-journal/journal-host-database.ts'
const RELEASES = {
  'the newest release': () => resolveRecentStableReleaseRefs(2)[0]!,
  'the release before it': () => resolveRecentStableReleaseRefs(2)[1]!,
  'the oldest release with this chat database': () =>
    resolveOldestStableReleaseRefWith(HOST_DATABASE)
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

/** Opens the chat, edits, sends and rewinds it, then reopens it; returns what the user sees. */
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
      await rewindReleasedChat(journal, new Set(opened.snapshot.items.map((item) => item.itemId)))
      expect(journal.epoch).toBe('epoch-rewound')
      return { opened, seen: view(journal) }
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
    'admits every row %s wrote for a %s chat, then opens, edits, sends and rewinds it as the newest release does',
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
          // A release in the window wrote the shapes this build reads, so it opens as written,
          // and the edit records the card the old rows hold in its place among them.
          expect(ours.opened).toEqual({ snapshot: written.snapshot, cards: written.cards })
          const edits = openTestJournalHostDatabase(directory)
            .db.prepare(`SELECT ordinal FROM journal_outcomes
            WHERE field = 'queue.cards' AND entry_key = '"card-2"'`)
            .all()
          expect(edits).toContainEqual({ ordinal: JOURNAL_PREFIX_ORDINAL })
          await closeTestJournalHostDatabase(directory)
        }
        const newest = await releasedJournalOpener(RELEASES['the newest release']())
        expect(ours).toEqual(await carryOn(newest, agent, shipped, written))
      } finally {
        rmSync(directory, { recursive: true, force: true })
        rmSync(shipped, { recursive: true, force: true })
      }
    },
    SUITE_TIMEOUT_MS
  )
})
