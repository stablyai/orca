import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  journalRowSchemaVersion,
  type AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import {
  agentJournalTurnBody,
  isRunningAgentJournalTurn,
  legacyAgentJournalTurnStatusBody,
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from './agent-session-turn-record'

const turn: AgentJournalTurnLifecycle = {
  turnId: 't1',
  state: 'completed',
  userItemId: 'codex:thread:t1:0',
  startedAt: 1_000,
  completedAt: 8_200,
  durationMs: 7_172
}

describe('readAgentJournalTurn', () => {
  it('reads the typed item and the legacy status form alike', () => {
    expect(readAgentJournalTurn(agentJournalTurnBody(turn))).toEqual(turn)
    expect(readAgentJournalTurn({ kind: 'status', text: 'x', turnLifecycle: turn })).toEqual(turn)
  })

  it('reads nothing off other bodies', () => {
    expect(readAgentJournalTurn({ kind: 'status', text: 'Conversation compacted.' })).toBeNull()
    expect(
      readAgentJournalTurn({
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'hi' }]
      })
    ).toBeNull()
    expect(readAgentJournalTurn(undefined)).toBeNull()
  })

  it('answers the running check for either form', () => {
    expect(isRunningAgentJournalTurn(agentJournalTurnBody({ ...turn, state: 'running' }))).toBe(
      true
    )
    expect(isRunningAgentJournalTurn({ kind: 'status', text: 'x', turnLifecycle: turn })).toBe(
      false
    )
  })
})

describe('readAgentJournalTurnOutcome', () => {
  it.each(['success', 'failure', 'cancellation'] as const)(
    'reads a %s verdict off either journal shape',
    (outcome) => {
      const withOutcome = { ...turn, outcome }
      expect(
        readAgentJournalTurnOutcome(readAgentJournalTurn(agentJournalTurnBody(withOutcome)))
      ).toBe(outcome)
      expect(
        readAgentJournalTurnOutcome(
          readAgentJournalTurn({ kind: 'status', text: 'x', turnLifecycle: withOutcome })
        )
      ).toBe(outcome)
    }
  )

  it('never reads an old host completed row as success', () => {
    // The mixed-version case this field exists for. Hosts that predate it wrote
    // `completed` for a turn the provider ended with an API error, so a newer
    // client must read those as UNKNOWN. Collapsing absent into success would
    // make every historical failure indistinguishable from a clean turn.
    expect(readAgentJournalTurnOutcome(turn)).toBeNull()
    expect(readAgentJournalTurnOutcome({ turnId: 't', state: 'completed' })).toBeNull()
    expect(
      readAgentJournalTurnOutcome(
        readAgentJournalTurn({ kind: 'status', text: 'Claude turn completed', turnLifecycle: turn })
      )
    ).toBeNull()
  })

  it('reads a verdict from a later vocabulary as unknown rather than an arm', () => {
    // The persisted field is an open string so a newer host's row stays readable.
    // That means the decoded value is typed as an arm this build knows without
    // having been checked against one, and this reader is the check.
    expect(readAgentJournalTurnOutcome({ ...turn, outcome: 'partially-refused' })).toBeNull()
  })

  it('answers unknown for a body that carries no turn at all', () => {
    expect(readAgentJournalTurnOutcome(null)).toBeNull()
    expect(readAgentJournalTurnOutcome(undefined)).toBeNull()
    expect(
      readAgentJournalTurnOutcome(readAgentJournalTurn({ kind: 'status', text: 'compacted' }))
    ).toBeNull()
  })
})

describe('legacyAgentJournalTurnStatusBody', () => {
  it('names the agent from the lifecycle identity and never calls an unobserved end completed', () => {
    expect(legacyAgentJournalTurnStatusBody(turn, 'legacy:claude:s:turn-lifecycle%3At1')).toEqual({
      kind: 'status',
      text: 'Claude turn completed',
      turnLifecycle: turn
    })
    expect(
      legacyAgentJournalTurnStatusBody(
        { turnId: 't2', state: 'unverifiable', startedAt: 1 },
        'legacy:codex:s:turn-lifecycle%3At2'
      ).text
    ).toBe('Codex turn outcome unverifiable')
  })

  it('carries the verdict to a client that predates the turn item', () => {
    // The downgrade is the only carrier an old client gets. Its own text still
    // reads "completed" — that copy is the pre-existing contract and this change
    // does not move it — but the verdict travels under `turnLifecycle`, so a
    // client that learns to read it needs no host change.
    const failed = { ...turn, outcome: 'failure' as const }
    expect(legacyAgentJournalTurnStatusBody(failed, 'legacy:claude:s:turn-lifecycle%3At1')).toEqual(
      {
        kind: 'status',
        text: 'Claude turn completed',
        turnLifecycle: failed
      }
    )
  })
})

describe('journalRowSchemaVersion', () => {
  it('stamps only rows that carry a turn item with the current version', () => {
    expect(AGENT_SESSION_JOURNAL_SCHEMA_VERSION).toBe(3)
    expect(journalRowSchemaVersion([agentJournalTurnBody(turn)])).toBe(3)
    expect(journalRowSchemaVersion([{ kind: 'message' }, { kind: 'status' }])).toBe(2)
    expect(journalRowSchemaVersion([])).toBe(2)
  })
})
