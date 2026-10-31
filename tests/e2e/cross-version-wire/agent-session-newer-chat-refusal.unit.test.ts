import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION,
  type AgentSessionJournalIdentity,
  type AgentSessionJournalProviderHandle
} from '../../../src/shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../src/shared/agent-session-provider-handle-encoding'
import type { AgentSessionRefusalReference } from '../../../src/shared/agent-session-wire-refusals'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { journalOpenRefusal } from '../../../src/main/native-chat/agent-session-journal/journal-open-failure'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef,
  releaseModuleExport
} from './release-checkout'

// Newer journals must yield the newer-Orca refusal to old clients, never damage wording.
// Unknown bodies refuse as a newer Orca's here; also probe the older host’s handling of those rows.
const SUITE_TIMEOUT_MS = 180_000
// The last release that does not know the newer-Orca reason: its words fall back to the code's.
const BEFORE_NEWER_REASON_REF = 'v1.4.218'
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

type ReadHistoryParts = (code: string, details?: unknown, context?: unknown) => unknown[]
type NoticeEnglish = (parts: unknown[]) => string
type IsFinal = (refusal: AgentSessionRefusalReference | undefined) => boolean

let directory: string
const journals = createTrackedJournalOpener({ legacyInputs: true })

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

// Write two current journal items, then a newer body or an unknown closed row.
async function journalWithNewerRow(
  row: Record<string, unknown> = NEWER_ROW_KIND
): Promise<{ rows: string[]; newer: string }> {
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
    { kind: 'status', text: 'before' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 2 },
    { kind: 'status', text: 'also before' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const seq = journal.cursor().sequence + 1
  const newer = JSON.stringify({
    // A version the older build reads, so it meets the kind rather than a newer version.
    v: AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION,
    epoch: journal.epoch,
    seq,
    fence: 1,
    ts: 2_000,
    ...row
  })
  await journals.closeAll()
  insertTestJournalRowJson(
    openTestJournalHostDatabase(directory).db,
    IDENTITY.sessionId,
    seq,
    newer,
    2_000
  )
  return { rows: await storedRows(), newer }
}

async function storedRows(): Promise<string[]> {
  const rows = liveTestJournalRows(openTestJournalHostDatabase(directory).db, IDENTITY.sessionId)
  await closeTestJournalHostDatabase(directory)
  return rows.map((row) => row.rowJson)
}

/** This host's refusal of a newer Orca's chat, as `history` and `subscribe` raise it. */
async function newerChatRefusal(): Promise<AgentSessionRefusalReference> {
  await journalWithNewerRow()
  const failure = await journals.open({ identity: IDENTITY, stateDirectory: directory }).then(
    () => null,
    (error: unknown) => error
  )
  expect(failure).toMatchObject(SAVED_BY_NEWER_ORCA)
  await journals.closeAll()
  return journalOpenRefusal(failure)
}

/** How a released client words a read refusal, and whether it stops retrying on it. */
async function releasedReader(ref: string) {
  const checkout = await materializeReleaseCheckout(ref)
  const notice = await importReleaseCheckoutModule(
    checkout,
    'src/shared/agent-session-refusal-notice.ts'
  )
  const readRefusal = await importReleaseCheckoutModule(
    checkout,
    'src/shared/structured-agent-session-read-refusal.ts'
  )
  const parts = releaseModuleExport<ReadHistoryParts>(notice, 'agentSessionReadHistoryRefusalParts')
  const english = releaseModuleExport<NoticeEnglish>(notice, 'agentSessionWriteNoticeEnglish')
  const isFinal = releaseModuleExport<IsFinal>(readRefusal, 'isFinalAgentSessionReadRefusal')
  // The pane's own Retry stands beside the words, as on desktop.
  const words = (refusal: { code: string; details?: unknown }) =>
    english(parts(refusal.code, refusal.details, { retryControl: true }))
  return { words, isFinal }
}

describe('a chat a newer Orca saved, across versions', () => {
  it(
    'old client against new host: a release before the reason words it as an unreadable history and keeps retrying',
    async () => {
      const refusal = await newerChatRefusal()
      const released = await releasedReader(BEFORE_NEWER_REASON_REF)
      const code = { code: refusal.code }
      const damage = { code: refusal.code, details: { reason: 'journalCorrupt' } }
      expect(released.words(refusal)).toBe(released.words(code))
      expect(released.words(refusal)).not.toBe(released.words(damage))
      expect(released.isFinal(refusal)).toBe(false)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'old client against new host: the newest release words it as its own, never as damage',
    async () => {
      rmSync(directory, { recursive: true, force: true })
      directory = mkdtempSync(join(tmpdir(), 'orca-newer-chat-xv-'))
      const refusal = await newerChatRefusal()
      const released = await releasedReader(resolveBaselineReleaseRef())
      const damage = { code: refusal.code, details: { reason: 'journalCorrupt' } }
      expect(released.words(refusal)).not.toBe('')
      expect(released.words(refusal)).not.toBe(released.words(damage))
    },
    SUITE_TIMEOUT_MS
  )

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
