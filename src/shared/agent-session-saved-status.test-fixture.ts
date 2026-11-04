import type { AgentSessionLastTurn } from './agent-session-last-turn'
import type { AgentSessionRecord } from './agent-session-record'
import type { AgentSessionStatusSummary } from './agent-session-wire'
import type { AgentTurnOutcome } from './agent-turn-outcome'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from './agent-session-record.test-fixture'

export const SAVED_STATUS_AT = 22_000

export const savedStatusContracts = (
  [
    [{ state: 'settled', outcome: 'success', at: SAVED_STATUS_AT }, 'success', 2, null],
    [{ state: 'open', at: SAVED_STATUS_AT }, 'cancellation', 5, 'Interrupted by user'],
    [
      { state: 'settled', outcome: 'cancellation', at: SAVED_STATUS_AT },
      'cancellation',
      5,
      'Interrupted by user'
    ],
    [{ state: 'settled', outcome: 'failure', at: SAVED_STATUS_AT }, 'failure', 2, 'Failed'],
    [
      { state: 'settled', outcome: 'interruption', at: SAVED_STATUS_AT },
      'interruption',
      2,
      'Failed'
    ]
  ] satisfies [AgentSessionLastTurn, AgentTurnOutcome, number, string | null][]
).map(([lastTurn, outcome, attentionClass, text]) => ({
  record: {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'session-1' })),
    sessionId: 'session-1',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'wt-1',
      workspaceKind: 'git-worktree'
    },
    updatedAt: SAVED_STATUS_AT + 60_000,
    lastTurn: { ...lastTurn, prompt: 'saved prompt', reply: 'saved reply' }
  } satisfies AgentSessionRecord,
  summary: {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'claude',
    status: 'idle',
    latestPrompt: 'saved prompt',
    lastAssistantMessage: 'saved reply',
    runtimePermission: null,
    turnOutcome: outcome,
    statusStartedAt: SAVED_STATUS_AT,
    updatedAt: SAVED_STATUS_AT
  } satisfies AgentSessionStatusSummary,
  outcome,
  attentionClass,
  text
}))
