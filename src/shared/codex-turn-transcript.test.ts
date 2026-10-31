import { describe, expect, it } from 'vitest'
import { reconcileCodexTranscriptTurn, type CodexTranscriptTurn } from './codex-turn-transcript'

const event = (payload: unknown): Record<string, unknown> => ({ type: 'event_msg', payload })

describe('Codex root turn evidence', () => {
  it('ignores a stale abort for an older turn and a quoted interruption message', () => {
    const turn: CodexTranscriptTurn = { interrupted: false }
    reconcileCodexTranscriptTurn(turn, [
      event({ type: 'task_started', turn_id: 'new' }),
      event({ type: 'turn_aborted', turn_id: 'old', reason: 'interrupted' }),
      event({ type: 'agent_message', message: 'Conversation interrupted - use /feedback' })
    ])
    expect(turn).toEqual({ turnId: 'new', interrupted: false })
    reconcileCodexTranscriptTurn(turn, [
      event({ type: 'turn_aborted', turn_id: 'new', reason: 'interrupted' })
    ])
    expect(turn.interrupted).toBe(true)
    reconcileCodexTranscriptTurn(turn, [event({ type: 'task_started', turn_id: 'next' })])
    expect(turn).toEqual({ turnId: 'next', interrupted: false })
  })

  it('accepts older abort events without a turn id and ignores other abort reasons', () => {
    const turn: CodexTranscriptTurn = { interrupted: false }
    reconcileCodexTranscriptTurn(turn, [event({ type: 'turn_aborted', reason: 'budget_limited' })])
    expect(turn.interrupted).toBe(false)
    reconcileCodexTranscriptTurn(turn, [event({ type: 'turn_aborted', reason: 'interrupted' })])
    expect(turn.interrupted).toBe(true)
    reconcileCodexTranscriptTurn(turn, [event({ type: 'turn_complete' })])
    expect(turn.interrupted).toBe(false)
  })
})
