import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity,
  AgentSessionJournalProviderHandle
} from '../../../src/shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../src/shared/agent-session-provider-handle-encoding'
import { USER_MESSAGE_SOURCE } from '../../../src/shared/agent-session/agent-session-message-source'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// A send this build's quit left queued is an ordinary pending submission, so a build from before
// the kept send still reads it, its source included, and settles it on its next start. (A queued
// card is a journal row this build writes at a newer row version, which keeps the chat read-only
// there; users don't downgrade.) The main commit the kept send branched from; move it to the
// newest release that predates it. A baseline holding this change tests no downgrade.
const BASELINE_REF = '5a56636f6679071d6ec68b851ef7932cd3222560'
const JOURNAL = 'src/main/native-chat/agent-session-journal'
const HOST_RESTARTED = agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
  surface: 'rejection'
})

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-kept-downgrade',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('native-1', null)
}

/** The identity as builds before the neutral provider handle took it. */
type OlderJournalIdentity = Omit<AgentSessionJournalIdentity, 'providerHandle'> & {
  providerHandle: AgentSessionJournalProviderHandle
}

const OLDER_IDENTITY: OlderJournalIdentity = {
  ...IDENTITY,
  providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null }
}

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

type OlderJournal = {
  submission: (id: string) => { dispatchState: string; reason: string | null } | undefined
  wroteBeforeOpen: (sequence: number | undefined) => boolean
  rejectQueuedSubmissions: (
    fence: number,
    rejection: typeof HOST_RESTARTED,
    which: (submission: { acceptedSequence?: number }) => boolean
  ) => Promise<string[]>
  repair: { malformedRows: number }
}

type OlderOpener = {
  open: (options: {
    identity: OlderJournalIdentity
    stateDirectory: string
  }) => Promise<OlderJournal>
  closeAll: () => Promise<void>
}

async function olderOpener(): Promise<OlderOpener> {
  const checkout = await materializeReleaseCheckout(BASELINE_REF)
  const support = await importReleaseCheckoutModule(
    checkout,
    `${JOURNAL}/journal-host-database-test-support.ts`
  )
  const create = support.createTrackedJournalOpener
  if (typeof create !== 'function') {
    throw new Error('the pinned build exports no createTrackedJournalOpener')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned build's own test opener; each member read here is named in `OlderOpener`, and a changed one fails the test.
  return create() as OlderOpener
}

async function acceptPersonSend(
  journal: Awaited<ReturnType<ReturnType<typeof createTrackedJournalOpener>['open']>>,
  id: string
): Promise<void> {
  await journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: `fp-${id}`,
    body: message(id),
    fence: 0,
    handoverRecorded: true,
    origin: 'client',
    source: USER_MESSAGE_SOURCE
  })
}

test("an older build reads the send this build's quit left queued, its source included, and settles it", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-kept-leftover-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    const quitting = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    await acceptPersonSend(quitting, 'left-queued')
    await journals.closeAll()

    const older = await olderOpener()
    try {
      const downgraded = await older.open({ identity: OLDER_IDENTITY, stateDirectory: directory })
      expect(downgraded.repair).toEqual({ malformedRows: 0 })
      expect(downgraded.submission('left-queued')).toMatchObject({ dispatchState: 'pending' })
      // Its delivery loop's first step, as that build runs it: rejected, never handed over.
      expect(
        await downgraded.rejectQueuedSubmissions(0, HOST_RESTARTED, (submission) =>
          downgraded.wroteBeforeOpen(submission.acceptedSequence)
        )
      ).toEqual(['left-queued'])
      expect(downgraded.submission('left-queued')).toMatchObject({
        dispatchState: 'rejected',
        reason: HOST_RESTARTED.reason
      })
    } finally {
      await older.closeAll()
    }
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)
