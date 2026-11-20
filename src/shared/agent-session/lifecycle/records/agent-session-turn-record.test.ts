import { describe, expect, it } from 'vitest'
import '../../journal/agent-session-journal-types'
import type { AgentJournalTurnLifecycle } from '../../journal/agent-session-journal-types'
import {
  agentJournalTurnBody,
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

describe('agentJournalTurnBody', () => {
  it('normalizes known fields and preserves extensions without changing the saved lifecycle', () => {
    const saved = {
      ...turn,
      kind: 'tool-call',
      laterField: { kept: true },
      providerTurnId: '',
      contextUsage: {
        window: { tokens: 10, capturedAt: 1, laterWindowField: true },
        used: { kind: 'unknown' as const, capturedAt: 1, laterUsedField: true },
        laterUsageField: { kept: true }
      }
    }
    const before = structuredClone(saved)
    expect(agentJournalTurnBody(saved)).toEqual({
      kind: 'turn',
      ...turn,
      laterField: { kept: true },
      contextUsage: saved.contextUsage
    })
    expect(saved).toEqual(before)
  })
})

describe('readAgentJournalTurnOutcome', () => {
  it('never reads an old host completed row as success', () => {
    // Pre-outcome hosts marked API-error turns completed; absent verdict must remain unknown or historical failures become successes.
    expect(readAgentJournalTurnOutcome(turn)).toBeNull()
    expect(readAgentJournalTurnOutcome({ turnId: 't', state: 'completed' })).toBeNull()
    expect(
      readAgentJournalTurnOutcome(
        readAgentJournalTurn({ kind: 'status', text: 'Claude turn completed', turnLifecycle: turn })
      )
    ).toBeNull()
  })
})
