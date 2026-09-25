import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { projectStructuredAgentSessionStatusSummary } from './structured-agent-session-projection'
import { structuredAgentSessionRowStateStartedAt } from './structured-agent-session-status-started-at'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody,
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence * 100, body, ...extra }
}

function submission(
  clientMessageId: string,
  submittedAt: number,
  dispatchState: AgentJournalSubmission['dispatchState'] = 'pending'
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt,
    resolvedAt: dispatchState === 'pending' ? null : submittedAt + 1
  }
}

const ask = item('ask', 1, {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'go' }]
})
const childLinkage = { agentId: 'child-1', parentAgentId: 'root', producerKind: 'agent' } as const

function pendingApproval(itemId: string, sequence: number, extra: Partial<AgentJournalRenderItem>) {
  return item(
    itemId,
    sequence,
    {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    extra
  )
}

function summaryOf(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[] = []) {
  return projectStructuredAgentSessionStatusSummary(items, submissions, 1)
}

describe('when the session entered its status', () => {
  it('dates idle by when its own newest turn ended, whatever a subagent wrote after', () => {
    const turn = item('turn', 2, {
      kind: 'turn',
      turnId: 't1',
      state: 'completed',
      outcome: 'success',
      startedAt: 150,
      completedAt: 900
    })
    const childProse = item(
      'child',
      3,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'still going' }] },
      { ...childLinkage, observedAt: 5_000 }
    )
    expect(summaryOf([ask, turn])).toMatchObject({ status: 'idle', statusStartedAt: 900 })
    expect(summaryOf([ask, turn, childProse])).toMatchObject({
      status: 'idle',
      statusStartedAt: 900
    })
  })

  it('dates a turn recovery settled by when recovery wrote it, not the end it restates', () => {
    const settled = item(
      'turn',
      2,
      { kind: 'turn', turnId: 't1', state: 'interrupted', startedAt: 150, completedAt: 400 },
      { recovered: true, recoveredAt: 7_000 }
    )
    const unverifiable = item(
      'turn',
      2,
      { kind: 'turn', turnId: 't1', state: 'unverifiable', startedAt: 150 },
      { recovered: true, recoveredAt: 7_000 }
    )
    expect(summaryOf([ask, settled]).statusStartedAt).toBe(7_000)
    expect(summaryOf([ask, unverifiable]).statusStartedAt).toBe(7_000)
  })

  it('leaves an idle state undated when the journal records no end for it', () => {
    const undated = item('turn', 2, { kind: 'turn', turnId: 't1', state: 'unverifiable' })
    expect(summaryOf([ask, undated])).not.toHaveProperty('statusStartedAt')
    expect(summaryOf([ask])).not.toHaveProperty('statusStartedAt')
  })

  it('dates working by the running turn, which a mid-turn send joins rather than restarts', () => {
    const running = item('turn', 2, {
      kind: 'turn',
      turnId: 't1',
      state: 'running',
      requestedAt: 120,
      startedAt: 150
    })
    const steer = submission('steer', 800)
    expect(summaryOf([ask, running])).toMatchObject({ status: 'working', statusStartedAt: 120 })
    expect(summaryOf([ask, running], [steer])).toMatchObject({
      status: 'working',
      statusStartedAt: 120
    })
    const unrequested = item('turn', 2, {
      kind: 'turn',
      turnId: 't1',
      state: 'running',
      startedAt: 150
    })
    expect(summaryOf([ask, unrequested]).statusStartedAt).toBe(150)
  })

  it('dates working before any turn opens by the earliest send still unanswered', () => {
    const settled = item('turn', 2, {
      kind: 'turn',
      turnId: 't1',
      state: 'completed',
      completedAt: 300
    })
    const sends = [
      submission('answered', 100, 'accepted'),
      submission('second', 700),
      submission('first', 500)
    ]
    expect(summaryOf([ask, settled], sends)).toMatchObject({
      status: 'working',
      statusStartedAt: 500
    })
  })

  it("dates attention by the session's own oldest ask; a subagent's ask leaves its clock alone", () => {
    const running = item('turn', 2, {
      kind: 'turn',
      turnId: 't1',
      state: 'running',
      startedAt: 150
    })
    const childAsk = pendingApproval('child-ask', 3, { ...childLinkage, observedAt: 400 })
    const ownAsk = pendingApproval('own-ask', 4, { observedAt: 600 })
    const laterOwnAsk = pendingApproval('later-own-ask', 5, { observedAt: 800 })
    // The subagent's ask is its own child record's wait; the session's own agent is still working.
    expect(summaryOf([ask, running, childAsk])).toMatchObject({
      status: 'working',
      statusStartedAt: 150
    })
    expect(summaryOf([ask, running, childAsk, ownAsk, laterOwnAsk])).toMatchObject({
      status: 'attention',
      statusStartedAt: 600
    })
  })
})

describe('the row clock a status writer takes from the host', () => {
  it("dates the row only while it shows the main agent's own state", () => {
    const dated = { statusStartedAt: 900 }
    expect(
      structuredAgentSessionRowStateStartedAt(
        { state: 'done', mainAgent: { state: 'done' } },
        dated
      )
    ).toBe(900)
    // Child work holds the row open; the main agent's clock does not date that state.
    expect(
      structuredAgentSessionRowStateStartedAt(
        { state: 'working', mainAgent: { state: 'done' } },
        dated
      )
    ).toBeUndefined()
    expect(
      structuredAgentSessionRowStateStartedAt({ state: 'done', mainAgent: { state: 'done' } }, {})
    ).toBeUndefined()
  })
})
