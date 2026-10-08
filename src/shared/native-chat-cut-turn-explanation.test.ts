import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import { agentSessionResponseInterruptedBody } from './agent-session-host-status-rows'
import { agentJournalItemKey } from './agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from './agent-session-journal-types'
import { structuredAgentTurnVerdictReader } from './native-chat-cut-turn-explanation'
import { projectStructuredAgentSessionStatusState } from './structured-agent-session-projection'
import { selectStructuredAgentSettledTurns } from './structured-agent-session-turn-timing'

const THREAD: AgentJournalTurnScope = { kind: 'thread' }
const IN_CUT: AgentJournalTurnScope = { kind: 'turn', turnItemId: 'orca:t1' }
let sequence = 0

function item(
  itemId: string,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope = THREAD
): AgentJournalRenderItem {
  sequence += 1
  return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
}

const user = (id: string) =>
  item(`orca:${id}`, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] })
const cutTurn = (id: string, userId: string) =>
  item(`orca:${id}`, {
    kind: 'turn',
    turnId: id,
    userItemId: `orca:${userId}`,
    state: 'interrupted',
    startedAt: 1_000,
    completedAt: 13_000
  })
const hostRow = (
  clientMessageId: string,
  body: AgentJournalItemBody,
  scope: AgentJournalTurnScope = THREAD
) => item(agentJournalItemKey({ provider: 'orca', clientMessageId }), body, scope)
/** The row the agent's own exit leaves: its fact, in error red. */
const exitRow = (scope: AgentJournalTurnScope = THREAD) =>
  hostRow(
    'provider-exit:s:1:g',
    {
      kind: 'status',
      ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
        agentName: 'Codex',
        surface: 'row'
      }),
      tone: 'error'
    },
    scope
  )
/** The row a reopen leaves for an old agent process it found gone. */
const ownerDeathRow = () =>
  hostRow('stale-session:s:death-1-2000', agentSessionResponseInterruptedBody(), IN_CUT)

/** The cut turn's verdict as the turn bar, the status row and the reader each take it. */
function readings(items: readonly AgentJournalRenderItem[]) {
  const turn = items.find((entry) => entry.itemId === 'orca:t1')!
  const { summary, latestRequest } = projectStructuredAgentSessionStatusState(items)
  return {
    reader: structuredAgentTurnVerdictReader(items)(turn),
    turnBar: selectStructuredAgentSettledTurns(items).get('orca:u1')?.verdict,
    status: summary.turnOutcome,
    // Never stored: the completion feed announces only a recorded outcome.
    recorded: latestRequest?.outcome
  }
}

describe('structuredAgentTurnVerdictReader', () => {
  it.each([
    ['scoped to the turn', () => [user('u1'), cutTurn('t1', 'u1'), exitRow(IN_CUT)]],
    [
      'about the conversation, right after the cut',
      () => [user('u1'), cutTurn('t1', 'u1'), exitRow()]
    ],
    [
      // The exit settle wrote its row but not the turn's end, which the next reopen then wrote.
      'followed by a reopen row for the same death',
      () => [user('u1'), cutTurn('t1', 'u1'), exitRow(IN_CUT), ownerDeathRow()]
    ]
  ])("reads a cut the agent's own exit explains as its failure, row %s", (_label, journal) => {
    expect(readings(journal())).toEqual({
      reader: 'failure',
      turnBar: 'failure',
      status: 'failure',
      recorded: null
    })
  })

  it.each([
    ['no row says why (a quit, an eviction)', () => [user('u1'), cutTurn('t1', 'u1')]],
    ['a reopen found the old agent gone', () => [user('u1'), cutTurn('t1', 'u1'), ownerDeathRow()]],
    [
      'the exit row answers a message sent after the cut',
      () => [user('u1'), cutTurn('t1', 'u1'), user('u2'), exitRow()]
    ]
  ])('keeps a cut interrupted when %s', (_label, journal) => {
    const read = readings(journal())
    expect(read.reader).toBe('interruption')
    expect(read.turnBar).toBe('interruption')
    expect(read.recorded).toBeNull()
  })
})
