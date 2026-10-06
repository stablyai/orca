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
import { USER_MESSAGE_SOURCE } from '../../../src/shared/agent-session-message-source'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { QUEUED_MESSAGE_PAUSED_KEPT } from '../../../src/shared/agent-session-queued-message-wire'
import { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { holdUnsentSends } from '../../../src/main/native-chat/agent-session-journal/journal-unsent-send-hold'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// A kept send is an ordinary waiting card held by a new value in its existing `hold_reason`
// column, placed ahead of the queue: no new state or column. A build with the queue but without
// this change reads an unknown hold as a plain one: it must list the card first and never send it,
// even after a person's turn ends a restart's pause, and must still settle a send this build's quit
// left queued. One exception lives in that build's own code: its /clear carries every card over
// without its hold, so the replacement's next turn sends a carried kept card. The main commit this change branched from, which has the queue; move it to the
// newest release that has the queue and predates this change. A baseline holding this change tests
// no downgrade.
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

type OlderCard = {
  messageId: string
  state: string
  position: number
  hostInstance: string
  holdReason: string | null
}

type OlderJournal = {
  queuedMessages: {
    list: () => readonly OlderCard[]
    pauses: (hostInstance: string) => { reason: string }[]
    adopt: (hostInstance: string) => Promise<boolean>
  }
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

type OlderNextSendable = (
  pauses: readonly { reason: string }[],
  cards: readonly OlderCard[]
) => OlderCard | null

/** The pinned build's drain pick (`nextSendableQueuedCard`): the card it would send next. */
async function olderNextSendable(): Promise<OlderNextSendable> {
  const checkout = await materializeReleaseCheckout(BASELINE_REF)
  const pause = await importReleaseCheckoutModule(checkout, `${JOURNAL}/queued-message-pause.ts`)
  const next = pause.nextSendableQueuedCard
  if (typeof next !== 'function') {
    throw new Error('the pinned build exports no nextSendableQueuedCard')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned build's own drain pick, called with that build's own pauses and cards.
  return next as OlderNextSendable
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

test('an older build lists a kept card first and never sends it, even after a person’s turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-kept-card-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    const earlier = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    await earlier.queuedMessages.insert({
      messageId: 'queued-card',
      body: message('queued-card'),
      fingerprint: 'fp-queued-card',
      hostInstance: 'host-a'
    })
    await acceptPersonSend(earlier, 'kept')
    await journals.closeAll()
    const reopened = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    await holdUnsentSends(reopened, {
      fence: 0,
      hostInstance: 'host-b',
      hold: { cause: 'hostRestarted' }
    })
    expect(reopened.queuedMessages.list().map((card) => card.messageId)).toEqual([
      'kept',
      'queued-card'
    ])
    await journals.closeAll()

    const older = await olderOpener()
    const nextSendable = await olderNextSendable()
    try {
      const downgraded = await older.open({ identity: OLDER_IDENTITY, stateDirectory: directory })
      const cards = () =>
        downgraded.queuedMessages.list().map(({ messageId, state, holdReason }) => ({
          messageId,
          state,
          holdReason
        }))
      expect(cards()).toEqual([
        { messageId: 'kept', state: 'waiting', holdReason: QUEUED_MESSAGE_PAUSED_KEPT },
        { messageId: 'queued-card', state: 'waiting', holdReason: null }
      ])
      expect(downgraded.queuedMessages.list()[0]!.position).toBeLessThan(1)
      expect(downgraded.submission('kept')).toMatchObject({ dispatchState: 'rejected' })
      // A person's turn there adopts every card into its process, which ends the restart's
      // pause; the kept card's hold survives it, so its drain never picks it. That build skips a
      // held card as it skips a failed send's, so the card behind it is the one it sends.
      expect(await downgraded.queuedMessages.adopt('host-c')).toBe(true)
      expect(cards()[0]).toMatchObject({
        messageId: 'kept',
        holdReason: QUEUED_MESSAGE_PAUSED_KEPT
      })
      expect(downgraded.queuedMessages.pauses('host-c')).toEqual([])
      expect(
        nextSendable(downgraded.queuedMessages.pauses('host-c'), downgraded.queuedMessages.list())
          ?.messageId
      ).toBe('queued-card')
    } finally {
      await older.closeAll()
    }
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)

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
