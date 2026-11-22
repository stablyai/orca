import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION
} from '../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionJournalIdentity,
  AgentSessionJournalProviderHandle
} from '../../../../src/shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../../src/shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA,
  seedLegacyTestJournal
} from '../../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import '../../../../src/main/native-chat/agent-session-journal/replay/journal-open-failure'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  releaseModuleExport
} from '../release-checkouts/release-checkout'

// Newer journals must yield the newer-Orca refusal to old clients, never damage wording.
// Unknown bodies refuse as a newer Orca's here; also probe the older host’s handling of those rows.
const SUITE_TIMEOUT_MS = 180_000
// The last release that does not know the newer-Orca reason: its words fall back to the code's.

// Pin a main build sharing this database/schema for writable downgrade; move to the first release that ships it.
const WRITABLE_BASELINE_REF = '3727100cc9dbcea6201f8a3e506676a3c4b53b18'
const JOURNAL = 'src/main/native-chat/agent-session-journal'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-newer-chat',
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

let directory: string
const journals = createTrackedJournalOpener()

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-newer-chat-xv-'))
})

afterAll(async () => {
  await journals.closeAll()
  rmSync(directory, { recursive: true, force: true })
})

const NEWER_BODY_KIND = { kind: 'plan-card', steps: [{ text: 'by a newer build' }] }
const NEWER_NESTED_LITERAL = {
  kind: 'approval',
  title: 'Approve the change?',
  detail: null,
  options: [{ id: 'yes', label: 'Yes' }],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null },
  subject: { kind: 'diff', path: 'a.ts' }
}

/** A row of a kind this build does not know: the journal's open is refused as a newer Orca's. */
const NEWER_ROW_KIND = { kind: 'future-mark' }

const EPOCH = 'epoch-newer-chat'

// A saved chat of two items, then a newer body or an unknown closed row, all before this build
// first opens it: this build reads saved rows only when it first converts the chat.
async function journalWithNewerRow(
  row: Record<string, unknown> = NEWER_ROW_KIND
): Promise<{ rows: string[]; newer: string }> {
  const database = openTestJournalHostDatabase(directory)
  seedLegacyTestJournal(database, { identity: IDENTITY, mintEpoch: () => EPOCH, now: () => 1_000 })
  const stored = (seq: number, fields: Record<string, unknown>) =>
    JSON.stringify({
      // A version the older build reads, so it meets the kind rather than a newer version.
      v: AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION,
      epoch: EPOCH,
      seq,
      fence: 1,
      ts: 1_000 + seq,
      ...fields
    })
  const before = ['before', 'also before'].map((text, index) => ({
    kind: 'item',
    itemId: agentJournalItemKey({
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-1',
      ordinal: index * 2
    }),
    revision: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    body: { kind: 'status', text }
  }))
  before.forEach((fields, index) =>
    insertTestJournalRowJson(database.db, IDENTITY.sessionId, index + 2, stored(index + 2, fields))
  )
  const seq = before.length + 2
  const newer = stored(seq, row)
  insertTestJournalRowJson(database.db, IDENTITY.sessionId, seq, newer, 2_000)
  return { rows: await storedRows(), newer }
}

async function storedRows(): Promise<string[]> {
  const rows = liveTestJournalRows(openTestJournalHostDatabase(directory).db, IDENTITY.sessionId)
  await closeTestJournalHostDatabase(directory)
  return rows.map((row) => row.rowJson)
}

/** This host's refusal of a newer Orca's chat, as `history` and `subscribe` raise it. */

/** How a released client words a read refusal, and whether it stops retrying on it. */

describe('a chat a newer Orca saved, across versions', () => {
  // Older hosts delete unknown row kinds: ship their reader first or bump v before writing them.
  // Move this baseline only to a release that preserves unknown bodies.
  it.each([
    ['body kind', NEWER_BODY_KIND],
    ['plan subject kind', NEWER_NESTED_LITERAL]
  ])(
    "this build refuses a newer build's %s as a newer Orca's and keeps it; a build before it deletes it",
    async (_value, body) => {
      rmSync(directory, { recursive: true, force: true })
      directory = mkdtempSync(join(tmpdir(), 'orca-newer-chat-xv-'))
      const { rows, newer } = await journalWithNewerRow({
        kind: 'item',
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body
      })
      await expect(
        journals.open({ identity: IDENTITY, stateDirectory: directory })
      ).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
      await journals.closeAll()
      expect(await storedRows()).toEqual(rows)

      const checkout = await materializeReleaseCheckout(WRITABLE_BASELINE_REF)
      const support = await importReleaseCheckoutModule(
        checkout,
        `${JOURNAL}/journal-host-database-test-support.ts`
      )
      const older = releaseModuleExport<
        () => {
          open: (options: {
            identity: OlderJournalIdentity
            stateDirectory: string
          }) => Promise<unknown>
          closeAll: () => Promise<void>
        }
      >(support, 'createTrackedJournalOpener')()
      try {
        await older.open({ identity: OLDER_IDENTITY, stateDirectory: directory })
      } finally {
        await older.closeAll()
      }
      expect(await storedRows()).not.toContain(newer)
    },
    SUITE_TIMEOUT_MS
  )
})
