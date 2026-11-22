import { describe, expect, it } from 'vitest'
import {
  agentSessionOperationKey,
  evaluateAgentSessionOperation,
  type AgentSessionOperationRow
} from './agent-session-operation-ledger'

const NOW = 1_800_000_000_000

function operationId(timestamp: number, suffix = 'a'.repeat(32)): string {
  return `${String(timestamp).padStart(13, '0')}-${suffix}`
}

function evaluate(
  rows: Map<string, AgentSessionOperationRow>,
  overrides: Partial<{
    callerKey: string
    operationId: string
    fingerprint: string
    now: number
  }> = {}
) {
  return evaluateAgentSessionOperation({
    rows,
    callerKey: 'client-1',
    operationId: operationId(NOW),
    fingerprint: 'fp-1',
    now: NOW,
    ...overrides
  })
}

function admit(
  rows: Map<string, AgentSessionOperationRow>,
  overrides: Parameters<typeof evaluate>[1] = {}
): AgentSessionOperationRow {
  const decision = evaluate(rows, overrides)
  if (decision.decision !== 'admit') {
    throw new Error(`expected admit, got ${decision.decision}`)
  }
  rows.set(agentSessionOperationKey(decision.row.callerKey, decision.row.operationId), decision.row)
  return decision.row
}

describe('operation admission', () => {
  it('refuses the same id carrying different parameters', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    admit(rows)
    expect(evaluate(rows, { fingerprint: 'fp-2' })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_conflict',
      details: { reason: 'operationIdReused' }
    })
  })

  it('scopes ids per caller so two clients cannot collide or replay each other', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    admit(rows)
    expect(evaluate(rows, { callerKey: 'client-2' }).decision).toBe('admit')
  })

  it('admits a fresh id however many unexpired rows other callers hold', () => {
    // Why: a count cap filled by background agent traffic used to refuse the user's own send.
    const rows = new Map<string, AgentSessionOperationRow>()
    for (let index = 0; index < 5_000; index += 1) {
      admit(rows, {
        callerKey: `agent-${index % 10}`,
        operationId: operationId(NOW - index, index.toString(16).padStart(32, '0'))
      })
    }
    for (let index = 0; index < 600; index += 1) {
      admit(rows, {
        callerKey: 'desktop',
        operationId: operationId(NOW - index, `d${index.toString(16).padStart(31, '0')}`)
      })
    }
    const fresh = evaluate(rows, {
      callerKey: 'desktop',
      operationId: operationId(NOW, 'e'.repeat(32))
    })
    expect(fresh.decision).toBe('admit')
    // Retries of earlier ids still replay rather than running again.
    expect(
      evaluate(rows, {
        callerKey: 'agent-0',
        operationId: operationId(NOW, '0'.repeat(32))
      }).decision
    ).toBe('replay')
  })
})
