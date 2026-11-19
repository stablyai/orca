import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from './agent-session/journal/agent-session-journal-turn-scope'
import { DISPATCH_REJECTED_CANCELLED } from './agent-session/requests/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionTurnAssistantMessage } from './agent-session/requests/structured-agent-session-latest-request'
import { structuredAgentSessionSendTurn } from './structured-agent-session-send-turn'

const RUN = { clientMessageId: 'run', fingerprint: 'admitted' }
const THREAD: AgentJournalTurnScope = { kind: 'thread' }

function submission(
  clientMessageId: string,
  fields: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'admitted',
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 1,
    ...fields
  }
}

function row(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  turnScope: AgentJournalTurnScope = THREAD
): AgentJournalRenderItem {
  return { itemId, revision: 0, sequence, observedAt: sequence, turnScope, body }
}

const userRow = (id: string, sequence: number, turnScope?: AgentJournalTurnScope) =>
  row(
    agentJournalSubmissionKey(id),
    sequence,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
    turnScope
  )

const turnRow = (itemId: string, sequence: number, userItemId?: string) =>
  row(itemId, sequence, {
    kind: 'turn',
    turnId: itemId,
    state: 'completed',
    outcome: 'success',
    ...(userItemId === undefined ? {} : { userItemId })
  })

const said = (itemId: string, sequence: number, turnItemId: string, ...texts: string[]) =>
  row(
    itemId,
    sequence,
    {
      kind: 'message',
      role: 'assistant',
      blocks: texts.map((text) => ({ type: 'text' as const, text }))
    },
    { kind: 'turn', turnItemId }
  )

describe("a run's turn is only one its own id proves", () => {
  it('never takes a turn the Chat would group under its message by position or guess', () => {
    const pending = submission('run', { dispatchState: 'pending', resolvedAt: null })
    for (const turn of [
      // The provider resumed work on its own.
      turnRow('resumed', 2, 'resumed'),
      // An older record naming no opener.
      turnRow('unnamed', 2),
      // An opener this journal cannot resolve.
      turnRow('unknown-opener', 2, 'provider-item-of-something-else')
    ]) {
      const items = [userRow('run', 1), turn, said('a', 3, turn.itemId, 'PRIVATE OWNER RESULT')]
      expect(structuredAgentSessionSendTurn({ items, submissions: [pending] }, RUN)).toEqual({
        kind: 'pending'
      })
    }
  })

  it("takes the provider's id for its send once echoed, unless an earlier send carries it", () => {
    const items = [userRow('run', 1), turnRow('t1', 2, 'provider-user-1')]
    const echoed = submission('run', { providerItemId: 'provider-user-1' })
    expect(structuredAgentSessionSendTurn({ items, submissions: [echoed] }, RUN)).toMatchObject({
      kind: 'turn',
      itemId: 't1'
    })
    const opener = submission('owner', { providerItemId: 'provider-user-1' })
    expect(structuredAgentSessionSendTurn({ items, submissions: [opener, echoed] }, RUN)).toEqual({
      kind: 'shared'
    })
  })

  it('takes the turn the host says a Stop took it back from after it started that turn', () => {
    const takenBack = submission('run', {
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED,
      answeredInTurn: { turnItemId: 't1', via: 'start' }
    })
    const items = [userRow('run', 1), turnRow('t1', 2, 'provider-user-1')]
    expect(structuredAgentSessionSendTurn({ items, submissions: [takenBack] }, RUN)).toMatchObject({
      kind: 'turn',
      itemId: 't1'
    })
  })

  // The owner's turn, with the run's message steered into it and more after it.
  const sharedTurn = [
    userRow('owner', 1),
    turnRow('owner-turn', 2, agentJournalSubmissionKey('owner')),
    said('before', 3, 'owner-turn', 'PRIVATE OWNER TEXT'),
    userRow('run', 4, { kind: 'turn', turnItemId: 'owner-turn' }),
    said('run-answer', 5, 'owner-turn', 'ALERT RESULT'),
    userRow('later', 6, { kind: 'turn', turnItemId: 'owner-turn' }),
    said('later-answer', 7, 'owner-turn', 'PRIVATE OWNER ANSWER')
  ]

  it('has no turn of its own once the provider takes it into a running turn', () => {
    // Codex takes a steer under the running turn's own provider id.
    const steered = { providerItemId: 'provider-owner' }
    for (const later of [submission('later', steered), submission('run-2', steered)]) {
      const submissions = [submission('owner', steered), submission('run', steered), later]
      expect(structuredAgentSessionSendTurn({ items: sharedTurn, submissions }, RUN)).toEqual({
        kind: 'shared'
      })
    }
  })

  it('never takes the turn the host planned to send it into before the provider answers', () => {
    const unanswered = [
      { dispatchState: 'pending', resolvedAt: null },
      { dispatchState: 'unknown' }
    ] as const
    for (const fields of unanswered) {
      const submissions = [submission('owner'), submission('run', fields)]
      expect(
        structuredAgentSessionSendTurn({ items: sharedTurn.slice(0, 4), submissions }, RUN)
      ).toEqual({ kind: 'pending' })
    }
    // One that outlived its writer will never be answered.
    const recovered = submission('run', { dispatchState: 'unknown', recovered: true })
    expect(
      structuredAgentSessionSendTurn(
        { items: sharedTurn.slice(0, 4), submissions: [submission('owner'), recovered] },
        RUN
      )
    ).toEqual({ kind: 'none' })
  })
})

describe('a turn the provider may have folded another send into', () => {
  const runTurn = [
    userRow('owner', 1),
    userRow('run', 2),
    turnRow('t', 3, agentJournalSubmissionKey('run')),
    said('a', 4, 't', 'OWNER / RUN PRIVATE RESULT')
  ]
  const read = (items: AgentJournalRenderItem[], owner: AgentJournalSubmission) =>
    structuredAgentSessionSendTurn({ items, submissions: [owner, submission('run')] }, RUN)

  it("is no run's own while a send handed over before it opened is unanswered or opened nothing", () => {
    for (const owner of [
      submission('owner', { dispatchState: 'pending', resolvedAt: null, handedOverAt: 1 }),
      submission('owner', { dispatchState: 'unknown' }),
      submission('owner', { dispatchState: 'unknown', recovered: true }),
      // Answered in the same turn, which names only the run.
      submission('owner')
    ]) {
      expect(read(runTurn, owner)).toEqual({ kind: 'shared' })
    }
    // The earlier echo arrived late and took the turn over.
    const takenOver = runTurn.with(2, turnRow('t', 3, agentJournalSubmissionKey('owner')))
    expect(read(takenOver, submission('owner'))).toEqual({ kind: 'shared' })
  })

  it("is the run's own once every other send is out of it", () => {
    const items = [
      userRow('early', 1),
      // Folded into the turn before, which named only another send.
      userRow('folded', 2),
      turnRow('p', 3, agentJournalSubmissionKey('another')),
      ...runTurn.map((item) => ({ ...item, sequence: item.sequence + 3 })),
      // The owner's opened a turn of its own after the run's.
      turnRow('u', 8, agentJournalSubmissionKey('owner')),
      userRow('after', 9)
    ]
    const submissions = [
      submission('early', { dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED }),
      submission('folded'),
      submission('owner'),
      submission('run'),
      // Sent once the run's turn had ended, still unanswered.
      submission('after', { dispatchState: 'pending', resolvedAt: null, handedOverAt: 1 })
    ]
    expect(structuredAgentSessionSendTurn({ items, submissions }, RUN)).toMatchObject({
      kind: 'turn',
      itemId: 't'
    })
  })
})

describe("a queued run's card", () => {
  const card = { clientMessageId: 'card', fingerprint: 'admitted' }
  const handoff = (id: string, fields: Partial<AgentJournalSubmission> = {}) =>
    submission(id, { queuedMessageId: 'card', ...fields })

  it('has no turn of its own once edited, on any handoff, and follows only its newest one', () => {
    const items = [userRow('h2', 1), turnRow('t2', 2, agentJournalSubmissionKey('h2'))]
    expect(
      structuredAgentSessionSendTurn(
        { items, submissions: [handoff('h2', { payloadFingerprint: 'edited' })] },
        card
      )
    ).toEqual({ kind: 'edited' })
    // Taken back by a Stop, then edited and sent again.
    const returned = handoff('h1', {
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect(
      structuredAgentSessionSendTurn(
        { items, submissions: [returned, handoff('h2', { payloadFingerprint: 'edited' })] },
        card
      )
    ).toEqual({ kind: 'edited' })
    expect(
      structuredAgentSessionSendTurn({ items, submissions: [returned, handoff('h2')] }, card)
    ).toMatchObject({ kind: 'turn', itemId: 't2' })
  })
})

describe('the run result a webhook key is split across', () => {
  const body = 'k'.repeat(43)
  const key = `orcawh_${body}`

  it('reaches the post whole at every split point, so the cloud can redact it', () => {
    for (let at = 1; at < key.length; at += 1) {
      const items = [said('a', 1, 't', `Use ${key.slice(0, at)}`, `${key.slice(at)} now.`)]
      expect(structuredAgentSessionTurnAssistantMessage(items, 't')).toBe(`Use ${key} now.`)
    }
    // Written percent-encoded, JSON-escaped or Markdown-escaped, split anywhere.
    for (const written of [`orcawh%5F${body}`, `orcawh\\u005f${body}`, `orcawh\\_${body}`]) {
      for (let at = 1; at < written.length; at += 1) {
        const items = [
          said('a', 1, 't', `Use ${written.slice(0, at)}`, `${written.slice(at)} now.`)
        ]
        expect(structuredAgentSessionTurnAssistantMessage(items, 't')).toBe(`Use ${written} now.`)
      }
    }
    // Blocks that hold no key stay a line apart.
    expect(
      structuredAgentSessionTurnAssistantMessage([said('a', 1, 't', 'One.', 'Two.')], 't')
    ).toBe('One.\nTwo.')
  })
})
