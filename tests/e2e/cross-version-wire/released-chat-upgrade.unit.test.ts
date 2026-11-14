import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  type TrackedJournalOpener
} from '../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { restoreJournal } from '../../../src/main/native-chat/agent-session-journal/replay/journal-open'
import type { AgentJournalSnapshot } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { parseJournalRow } from '../../../src/main/native-chat/agent-session-journal/durable-rows/journal-row-schema'
import {
  readJournalSessionEpoch,
  type JournalStoredRow
} from '../../../src/main/native-chat/agent-session-journal/durable-rows/journal-row-table'
import type { AgentSessionJournal } from '../../../src/main/native-chat/agent-session-journal/journal-store'
import { readTestJournalSnapshot } from '../../../src/main/native-chat/agent-session-journal/journal-observation.test-support'
import { readAgentSessionHistory } from '../../../src/main/native-chat/agent-session-wire/publication/history/agent-session-history-page'
import {
  readQueuePublication,
  structuredQueueSendGate
} from '../../../src/main/native-chat/agent-session-wire/delivery/structured-agent-session-queued-publication'
import { resolveBaselineReleaseRef } from './release-checkout'
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
import type { ReleasedCard, ReleasedJournal, ReleasedOpener } from './released-chat-journal'

// The two releases before outcome storage, and the oldest release whose chat database this build still
// reads, writes a Claude and a Codex chat through its own writers. This build admits every row as
// written, opens the chat as that release had it, then edits a queued card (its first write, over
// a key the old rows hold), sends, and rewinds, which saves the kept chat again in this build's
// form. The release's rows stay its own: this build converts them and never writes them. What this
// build does after the open is checked on its own result, never against a release, so main stays
// free to change it.
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

type Card = Pick<ReleasedCard, 'messageId' | 'position'> & { state?: string }
const byPosition = <T extends Card>(cards: readonly T[]): T[] =>
  [...cards].sort((a, b) => a.position - b.position)

/** This build's chat and its live cards; a withdrawn card is no longer listed. */
const view = async (journal: AgentSessionJournal, now: () => number) => {
  const publication = await readQueuePublication(
    journal,
    structuredQueueSendGate(
      {
        store: {
          getConversation: () => null,
          getRecord: () => null,
          replacedRuntime: () => undefined
        },
        sessions: new Map([
          [journal.identity.sessionId, { journal, child: null, operationalRevision: 0 }]
        ])
      },
      journal.identity.sessionId,
      now
    )
  )
  // Nothing moves authority here, so a superseded read is a failure, not an empty queue.
  if (!publication) {
    throw new Error('the queue publication read was superseded')
  }
  return {
    snapshot: await readTestJournalSnapshot(journal),
    cards: byPosition(await journal.queuedMessages.list()),
    publishedCards: publication.queuedMessages
  }
}

/** A release's chat and its live cards, as that release reads them. */
const releasedView = (journal: ReleasedJournal) => ({
  snapshot: journal.snapshot(),
  cards: byPosition(journal.queuedMessages.list()).filter((card) => card.state !== 'withdrawn')
})

/** What the release wrote: its items, sends and live cards, in order. Fields a later build adds to
 * them are not compared (`toMatchObject`), so main may add one; a changed value or order still fails. */
const releaseWritten = ({
  snapshot,
  cards
}: {
  snapshot: AgentJournalSnapshot
  cards: readonly Card[]
}) => ({
  items: snapshot.items,
  submissions: snapshot.submissions,
  cards: cards.filter((card) => card.state !== 'withdrawn')
})

const kept = (items: AgentJournalSnapshot['items']) =>
  items.map(({ itemId, body }) => ({ itemId, body }))

/** The chat as a release opens it, over a copy so the original stays as the release left it. */
async function openedBy(opener: ReleasedOpener, agent: Agent, stateDirectory: string) {
  return opener
    .open({ identity: identityOf(agent), stateDirectory })
    .then(releasedView)
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
      const opened = await view(journal, written.now)
      await editReleasedCard(journal)
      if (prefix) {
        // The release's rows stay byte for byte; this build's writes go to its own store.
        const database = openTestJournalHostDatabase(stateDirectory)
        expect(liveTestJournalRows(database.db, options.identity.sessionId)).toEqual(prefix)
      }
      await sendAfterUpgrade(journal)
      const sent = await view(journal, written.now)
      expect(sent.snapshot.submissions).toContainEqual(
        expect.objectContaining({ clientMessageId: 'after-upgrade', dispatchState: 'accepted' })
      )
      const beforeRewind = journal.cursor()
      const database = openTestJournalHostDatabase(stateDirectory)
      const physicalEpoch = readJournalSessionEpoch(database.db, options.identity.sessionId)
      expect(physicalEpoch).not.toBeNull()
      await rewindReleasedChat(journal, new Set(opened.snapshot.items.map((item) => item.itemId)))
      expect(journal.cursor().epoch).toMatch(/^context-v1:/)
      expect(journal.cursor().epoch).not.toBe(beforeRewind.epoch)
      expect(readJournalSessionEpoch(database.db, options.identity.sessionId)).toBe(physicalEpoch)
      // A client still at the old context is told to reload rather than sent a partial history.
      expect(
        await readAgentSessionHistory(journal, {
          sessionId: options.identity.sessionId,
          direction: 'after',
          cursor: beforeRewind
        })
      ).toMatchObject({ ok: false, reset: 'epoch_changed' })
      const seen = await view(journal, written.now)
      // The rewind keeps every message the release wrote and every card not taken back, the edit
      // included.
      expect(kept(seen.snapshot.items)).toEqual(kept(opened.snapshot.items))
      expect(seen.cards.map((card) => card.messageId)).toEqual(
        opened.cards.map((card) => card.messageId)
      )
      expect(seen.cards).toHaveLength(1)
      expect(seen.cards).toEqual(sent.cards)
      expect(seen.publishedCards.map((card) => card.messageId)).toEqual(['card-2'])
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
    .then(async (journal) => {
      const reopened = await view(journal, written.now)
      expect(reopened.publishedCards.map((card) => card.messageId)).toEqual(['card-2'])
      return reopened
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
          // A release in the window wrote the shapes this build reads, so it opens as written.
          expect(releaseWritten(ours.opened)).toMatchObject(releaseWritten(written))
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
