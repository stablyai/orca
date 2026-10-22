import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
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
  resolveBaselineReleaseRef
} from './release-checkout'

/**
 * A chat a newer Orca saved now fails its load here with the newer-Orca reason, where this host used
 * to serve it read-only (Rule 3: an existing read answers differently). An older client gets that
 * refusal instead of pages: it must word it with what it has and never call it damage. And this
 * build keeps a body of a kind it does not know (or a plan subject of one), writable, instead of
 * deleting from it, which an older host meets when it opens a journal holding such a body.
 */
const SUITE_TIMEOUT_MS = 180_000
// The last release that does not know the newer-Orca reason: its words fall back to the code's.
const BEFORE_NEWER_REASON_REF = 'v1.4.218'
// A main build that shares this one's host database and schema version, so a downgrade to it opens
// the journal writable. No release tag has that database yet; move to the first one that does.
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
const journals = createTrackedJournalOpener()

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-newer-chat-xv-'))
})

afterAll(async () => {
  await journals.closeAll()
  rmSync(directory, { recursive: true, force: true })
})

/** A function the checked-out build exports, typed as the caller calls it. */
function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (value === undefined) {
    throw new Error(`the checked-out build exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an export the checked-out build defines; each caller names the shape it uses, and a changed one fails the test.
  return value as T
}

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

/** This build's journal of two items, then a row as a newer build wrote it: an item holding
 *  `body`, or `row` itself: closed. */
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
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
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
  return { rows: storedRows(), newer }
}

function storedRows(): string[] {
  const rows = liveTestJournalRows(openTestJournalHostDatabase(directory).db, IDENTITY.sessionId)
  closeTestJournalHostDatabase(directory)
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
  const parts = releaseExport<ReadHistoryParts>(notice, 'agentSessionReadHistoryRefusalParts')
  const english = releaseExport<NoticeEnglish>(notice, 'agentSessionWriteNoticeEnglish')
  const isFinal = releaseExport<IsFinal>(readRefusal, 'isFinalAgentSessionReadRefusal')
  // The pane's own Retry stands beside the words, as on desktop.
  const words = (refusal: Pick<AgentSessionRefusalReference, 'code' | 'details'>) =>
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

  // Why a new body kind ships its reader first, or rides a bumped `v`: this build keeps one and
  // stays writable, but a build from before deletes the journal from it. Move the pinned build to
  // the first release with this rule, and the older build keeps the row too.
  it.each([
    ['body kind', NEWER_BODY_KIND],
    ['plan subject kind', NEWER_NESTED_LITERAL]
  ])(
    "this build keeps a newer build's %s and stays writable; a build before it deletes it",
    async (_value, body) => {
      rmSync(directory, { recursive: true, force: true })
      directory = mkdtempSync(join(tmpdir(), 'orca-newer-chat-xv-'))
      const { rows, newer } = await journalWithNewerRow({
        kind: 'item',
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body
      })
      const reopened = await journals.open({ identity: IDENTITY, stateDirectory: directory })
      expect(reopened.snapshot().items).toHaveLength(3)
      await journals.closeAll()
      expect(storedRows()).toEqual(rows)

      const checkout = await materializeReleaseCheckout(WRITABLE_BASELINE_REF)
      const support = await importReleaseCheckoutModule(
        checkout,
        `${JOURNAL}/journal-host-database-test-support.ts`
      )
      const older = releaseExport<
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
      expect(storedRows()).not.toContain(newer)
    },
    SUITE_TIMEOUT_MS
  )
})
