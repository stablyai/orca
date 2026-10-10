import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import type {
  AgentJournalSubmission,
  AgentSessionJournalIdentity
} from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../src/shared/agent-session-wire'
import {
  createTrackedJournalOpener,
  type TrackedJournalOpener
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { projectJournalBatch } from '../../../src/main/native-chat/agent-session-wire/agent-session-journal-batch'
import { readAgentSessionHydrationPage } from '../../../src/main/native-chat/agent-session-wire/agent-session-history-page'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// Released clients that predate the published submission position and answered turn: each must
// fold and draw a history page and an incremental batch carrying them exactly as it draws the same
// without them, whether the turn is named or stated as none.
const BASELINE_REFS = ['v1.4.219', 'v1.4.220'] as const

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-positions',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

/** A function the pinned release exports, typed as the caller calls it. */
function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) {
    throw new Error(`the pinned release exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a value the pinned release exports; each caller names the shape it uses, and a changed one fails the test.
  return value as T
}

type OldState = { submissions: Record<string, unknown>[]; items: unknown[] }

/** Submissions as an older host would carry them. */
function withoutNewFields(
  submissions: readonly AgentJournalSubmission[]
): AgentJournalSubmission[] {
  return submissions.map(
    ({ submittedSequence: _submitted, answeredInTurn: _turn, ...rest }) => rest
  )
}

/** A chat before and after three rejections: a queued send taken back, one its turn's end
 *  rejected, and one refused outright. */
async function journalWithRejections(directory: string, journals: TrackedJournalOpener) {
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
  const message = (text: string) => ({
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }]
  })
  for (const id of ['taken-back', 'still-queued']) {
    await journal.appendSubmission({
      clientMessageId: id,
      payloadFingerprint: id,
      body: message(id),
      fence: 1,
      handoverRecorded: true
    })
  }
  for (const id of ['turn-ended', 'refused']) {
    await journal.appendSubmission({
      clientMessageId: id,
      payloadFingerprint: id,
      body: message(id),
      fence: 1
    })
  }
  const before = readAgentSessionHydrationPage(journal, 1)
  const seen = journal.snapshot().cursor
  const cancelled = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
    surface: 'rejection'
  })
  await journal.resolveDispatch({
    clientMessageId: 'taken-back',
    state: 'rejected',
    ...cancelled,
    fence: 1,
    recovered: true
  })
  await journal.resolveDispatch({
    clientMessageId: 'turn-ended',
    state: 'rejected',
    ...cancelled,
    answeredInTurn: {
      turn: {
        provider: 'legacy',
        agent: 'codex',
        sessionId: IDENTITY.sessionId,
        recordId: 'turn-lifecycle:turn-1'
      },
      via: 'start'
    },
    fence: 1
  })
  await journal.resolveDispatch({
    clientMessageId: 'refused',
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('queueFull'), { surface: 'rejection' }),
    fence: 1
  })
  const since = journal.readSince(seen)
  const batch = since.ok
    ? projectJournalBatch({
        rows: since.rows,
        snapshot: journal.snapshot(),
        afterSequence: seen.sequence
      })
    : null
  if (!batch?.ok) {
    throw new Error('the batch did not project')
  }
  return { before, after: readAgentSessionHydrationPage(journal, 1), batch: batch.batch }
}

// Loads real release checkouts, cold extraction and transforms included.
test.each(BASELINE_REFS)(
  'a released client (%s) draws a page and a batch carrying journal positions and answered turns as it draws them without',
  async (ref) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-submission-positions-downgrade-'))
    const journals = createTrackedJournalOpener()
    try {
      const { before, after, batch } = await journalWithRejections(directory, journals)
      // Anti-vacuous: what this build publishes carries a position, a named turn, and stated none.
      expect(after.submissions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ clientMessageId: 'taken-back', answeredInTurn: null }),
          expect.objectContaining({
            clientMessageId: 'turn-ended',
            submittedSequence: expect.any(Number),
            answeredInTurn: { turnItemId: expect.any(String), via: 'start' }
          }),
          expect.objectContaining({ clientMessageId: 'refused', answeredInTurn: null })
        ])
      )
      expect(batch.submissions.map((entry) => entry.answeredInTurn)).toContain(null)

      const checkout = await materializeReleaseCheckout(ref)
      const reducer = await importReleaseCheckoutModule(
        checkout,
        'src/shared/structured-agent-session-reducer.ts'
      )
      const projection = await importReleaseCheckoutModule(
        checkout,
        'src/shared/structured-agent-session-message-projection.ts'
      )
      const reduce = releaseExport<(state: unknown, action: unknown) => OldState>(
        reducer,
        'reduceStructuredAgentSession'
      )
      const empty = releaseExport<unknown>(reducer, 'EMPTY_STRUCTURED_AGENT_SESSION')
      const project = releaseExport<
        (items: unknown[], outbox: unknown[], submissions: unknown[]) => unknown[]
      >(projection, 'projectStructuredAgentSessionMessages')
      const draw = (state: OldState) => ({
        submissions: state.submissions.map(
          ({ submittedSequence: _s, answeredInTurn: _t, ...rest }) => rest
        ),
        messages: project(state.items, [], state.submissions)
      })
      const fromPage = (page: AgentSessionHistoryPage) =>
        draw(reduce(empty, { type: 'history-page', page }))
      const fromBatch = (stripped: boolean) =>
        draw(
          reduce(reduce(empty, { type: 'history-page', page: before }), {
            type: 'event',
            event: {
              type: 'batch',
              sessionId: IDENTITY.sessionId,
              batch: stripped
                ? { ...batch, submissions: withoutNewFields(batch.submissions) }
                : batch,
              fence: 1
            }
          })
        )

      expect(fromPage(after)).toEqual(
        fromPage({ ...after, submissions: withoutNewFields(after.submissions) })
      )
      expect(fromBatch(false)).toEqual(fromBatch(true))
      // Anti-vacuous: the batch reached the old client's submissions.
      expect(fromBatch(false).submissions).toEqual(
        expect.arrayContaining([expect.objectContaining({ dispatchState: 'rejected' })])
      )
    } finally {
      await journals.closeAll()
      rmSync(directory, { recursive: true, force: true })
    }
  },
  180_000
)
