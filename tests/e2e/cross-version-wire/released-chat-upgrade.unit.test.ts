import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { restoreJournal } from '../../../src/main/native-chat/agent-session-journal/journal-open'
import { parseJournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import { resolveRecentStableReleaseRefs } from './release-checkout'
import { identityOf, writeReleasedChat } from './released-chat-writers'

// Each release in the downgrade window writes a Claude and a Codex chat through its own writers.
// This build admits every row as written and opens the chat to the state that release had.
const SUITE_TIMEOUT_MS = 180_000

describe('a chat a release in the downgrade window wrote, opened by this build', () => {
  it.each([
    ['the newest release', 'claude'],
    ['the newest release', 'codex'],
    ['the release before it', 'claude'],
    ['the release before it', 'codex']
  ] as const)(
    'admits every row %s wrote for a %s chat and opens it as that release had it',
    async (build, agent) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-released-chat-upgrade-'))
      const identity = identityOf(agent)
      try {
        const written = await writeReleasedChat(
          resolveRecentStableReleaseRefs(2)[build === 'the newest release' ? 0 : 1]!,
          agent,
          directory
        )
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
        // Anti-vacuous: the release wrote every row kind a chat holds.
        expect(new Set(rows.map((row) => JSON.parse(row.rowJson).kind))).toEqual(
          new Set([
            'epoch',
            'item',
            'tombstone',
            'submission',
            'dispatch',
            'lifecycle-batch',
            'queue'
          ])
        )
        expect(restoreJournal(database.db, identity.sessionId)).toMatchObject({
          newer: null,
          damage: null
        })
        await closeTestJournalHostDatabase(directory)
        const journals = createTrackedJournalOpener()
        try {
          const journal = await journals.open({
            identity,
            stateDirectory: directory,
            now: written.now
          })
          expect(journal.snapshot()).toEqual(written.snapshot)
          expect(journal.queuedMessages.list()).toEqual(written.cards)
        } finally {
          await journals.closeAll()
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    SUITE_TIMEOUT_MS
  )
})
