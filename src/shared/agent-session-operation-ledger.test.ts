import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from './agent-session-host-authority'
import {
  AGENT_SESSION_PROMPT_CANCEL_MAX_ITEM_ID_BYTES,
  AGENT_SESSION_PROMPT_CANCEL_MAX_PROMPTS,
  agentSessionOperationExpiry,
  agentSessionOperationKey,
  evaluateAgentSessionOperation,
  isAgentSessionOperationRow,
  pruneAgentSessionOperationRows,
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
    perClientLimit: number
    globalLimit: number
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
  it('admits a fresh id once and replays the identical retry', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    const replay = evaluate(rows)
    expect(replay).toEqual({ decision: 'replay', row })
  })

  it('refuses the same id carrying different parameters', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    admit(rows)
    expect(evaluate(rows, { fingerprint: 'fp-2' })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_conflict'
    })
  })

  it('scopes ids per caller so two clients cannot collide or replay each other', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    admit(rows)
    expect(evaluate(rows, { callerKey: 'client-2' }).decision).toBe('admit')
  })

  it('refuses a malformed or future-dated id', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    expect(evaluate(rows, { operationId: 'not-an-operation-id' })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_invalid'
    })
    // Why: a future-dated id would look new again after its own tombstone is collected.
    expect(
      evaluate(rows, {
        operationId: operationId(NOW + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1)
      })
    ).toEqual({ decision: 'refused', code: 'agent_session_operation_invalid' })
    expect(
      evaluate(rows, { operationId: operationId(NOW + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS) })
        .decision
    ).toBe('admit')
  })

  it('refuses an id older than the admission window instead of treating it as new', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const stale = operationId(NOW - AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS - 1)
    expect(evaluate(rows, { operationId: stale })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_expired'
    })
    expect(
      evaluate(rows, { operationId: operationId(NOW - AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) })
        .decision
    ).toBe('admit')
  })

  it('refuses new ids at the per-client and global caps rather than evicting tombstones', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    admit(rows, { operationId: operationId(NOW, 'b'.repeat(32)) })
    expect(evaluate(rows, { perClientLimit: 1 })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_capacity'
    })
    // A different caller is still refused once the global cap is reached.
    expect(evaluate(rows, { callerKey: 'client-2', globalLimit: 1 })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_capacity'
    })
    expect(evaluate(rows, { callerKey: 'client-2', perClientLimit: 1 }).decision).toBe('admit')
  })
})

describe('retention', () => {
  it('keeps a tombstone strictly longer than its id can be admitted as new', () => {
    const expiry = agentSessionOperationExpiry(NOW, NOW)
    const lastAdmissibleAt = NOW + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
    expect(expiry).toBeGreaterThan(lastAdmissibleAt)
    // Why: a retry landing in that gap would become a second spawn instead of a replay.
    const rows = new Map<string, AgentSessionOperationRow>()
    admit(rows)
    expect(pruneAgentSessionOperationRows(rows, lastAdmissibleAt).size).toBe(1)
    expect(evaluate(pruneAgentSessionOperationRows(rows, lastAdmissibleAt)).decision).toBe('replay')
  })

  it('anchors retention to the later of recording and stamping', () => {
    const late = agentSessionOperationExpiry(NOW + 10_000, NOW)
    expect(late).toBe(agentSessionOperationExpiry(NOW + 10_000, NOW + 10_000))
    expect(late).toBeGreaterThan(agentSessionOperationExpiry(NOW, NOW))
  })

  it('drops only rows past their own expiry', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    expect(pruneAgentSessionOperationRows(rows, row.expiresAt).size).toBe(0)
    expect(pruneAgentSessionOperationRows(rows, row.expiresAt - 1).size).toBe(1)
  })
})

describe('persisted row validation', () => {
  function promptCancelRow(
    row: AgentSessionOperationRow,
    prompts: { itemId: string; expectedRevision: number }[]
  ): AgentSessionOperationRow {
    return {
      ...row,
      outcome: {
        status: 'unknown',
        promptCancelSettlement: {
          phase: 'prepared',
          sessionId: 's-1',
          runtimeFence: 1,
          turnId: 'turn-1',
          target: prompts[0]!,
          prompts,
          resolvedAt: NOW
        }
      }
    }
  }

  it('accepts every recorded outcome shape', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    expect(isAgentSessionOperationRow(row)).toBe(true)
    expect(
      isAgentSessionOperationRow({ ...row, outcome: { status: 'succeeded', sessionId: 's-1' } })
    ).toBe(true)
    expect(isAgentSessionOperationRow({ ...row, outcome: { status: 'unknown' } })).toBe(true)
    expect(
      isAgentSessionOperationRow({
        ...row,
        outcome: {
          status: 'unknown',
          promptCancelSettlement: {
            phase: 'provider-confirmed',
            sessionId: 's-1',
            runtimeFence: 1,
            turnId: 'turn-1',
            target: { itemId: 'codex:thread:turn:1', expectedRevision: 1 },
            prompts: [{ itemId: 'codex:thread:turn:1', expectedRevision: 1 }],
            resolvedAt: NOW
          }
        }
      })
    ).toBe(true)
    expect(isAgentSessionOperationRow({ ...row, outcome: { status: 'failed', code: 'x' } })).toBe(
      true
    )
  })

  it('rejects rows a later build could misread', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    expect(isAgentSessionOperationRow({ ...row, operationId: 'garbage' })).toBe(false)
    expect(isAgentSessionOperationRow({ ...row, callerKey: '' })).toBe(false)
    expect(isAgentSessionOperationRow({ ...row, expiresAt: 1.5 })).toBe(false)
    expect(isAgentSessionOperationRow({ ...row, outcome: { status: 'succeeded' } })).toBe(false)
    const promptCancellation = promptCancelRow(row, [
      { itemId: 'codex:thread:turn:1', expectedRevision: 1 }
    ])
    if (
      promptCancellation.outcome.status !== 'unknown' ||
      !promptCancellation.outcome.promptCancelSettlement
    ) {
      throw new Error('prompt cancellation fixture was not built')
    }
    expect(
      isAgentSessionOperationRow({
        ...promptCancellation,
        outcome: {
          ...promptCancellation.outcome,
          promptCancelSettlement: {
            ...promptCancellation.outcome.promptCancelSettlement,
            runtimeFence: 0
          }
        }
      })
    ).toBe(false)
    expect(
      isAgentSessionOperationRow({
        ...row,
        outcome: {
          status: 'unknown',
          promptCancelSettlement: {
            phase: 'prepared',
            sessionId: 's-1',
            runtimeFence: 1,
            turnId: '',
            target: { itemId: 'codex:thread:turn:1', expectedRevision: 1 },
            prompts: [],
            resolvedAt: NOW
          }
        }
      })
    ).toBe(false)
    expect(isAgentSessionOperationRow({ ...row, outcome: null })).toBe(false)
    expect(isAgentSessionOperationRow(null)).toBe(false)
  })

  it('keeps accepting successful cancellation rows written before provider ids were bounded', () => {
    const row = admit(new Map<string, AgentSessionOperationRow>())

    expect(
      isAgentSessionOperationRow({
        ...row,
        outcome: {
          status: 'succeeded',
          sessionId: 's-1',
          cancelledTurnId: 'é'.repeat(257)
        }
      })
    ).toBe(true)
  })

  it('bounds prompt cancellation target count', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    const prompts = Array.from(
      { length: AGENT_SESSION_PROMPT_CANCEL_MAX_PROMPTS + 1 },
      (_, index) => ({
        itemId: `codex:thread:turn:${index}`,
        expectedRevision: 1
      })
    )

    expect(isAgentSessionOperationRow(promptCancelRow(row, prompts))).toBe(false)
  })

  it('bounds aggregate multibyte prompt cancellation item ids', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    const encoded = encodeURIComponent('界'.repeat(1_000))
    const prompts = Array.from({ length: 30 }, (_, index) => ({
      itemId: `orca:${encoded}${index}`,
      expectedRevision: 1
    }))
    expect(
      prompts.reduce((bytes, prompt) => bytes + Buffer.byteLength(prompt.itemId, 'utf8'), 0)
    ).toBeGreaterThan(AGENT_SESSION_PROMPT_CANCEL_MAX_ITEM_ID_BYTES)

    expect(isAgentSessionOperationRow(promptCancelRow(row, prompts))).toBe(false)
  })
})
