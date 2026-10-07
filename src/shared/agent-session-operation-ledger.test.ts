import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from './agent-session-host-authority'
import {
  agentSessionOperationExpiry,
  agentSessionOperationKey,
  claimAgentSessionOperation,
  evaluateAgentSessionOperation,
  pendingAgentSessionOperationRow,
  settleAgentSessionOperation,
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
      code: 'agent_session_operation_conflict',
      details: { reason: 'operationIdReused' }
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
      code: 'agent_session_operation_invalid',
      details: { reason: 'operationIdInvalid' }
    })
    // Why: a future-dated id would look new again after its own tombstone is collected.
    expect(
      evaluate(rows, {
        operationId: operationId(NOW + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1)
      })
    ).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason: 'operationIdInvalid' }
    })
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
      code: 'agent_session_operation_expired',
      details: { reason: 'operationExpired' }
    })
    expect(
      evaluate(rows, { operationId: operationId(NOW - AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) })
        .decision
    ).toBe('admit')
  })

  it('refuses new ids at the per-client and global caps rather than evicting tombstones', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const held = admit(rows, { operationId: operationId(NOW, 'b'.repeat(32)) })
    expect(evaluate(rows, { perClientLimit: 1 })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_capacity',
      details: { reason: 'operationCapacity', capacityReturnsAt: held.expiresAt }
    })
    // A different caller is still refused once the global cap is reached.
    expect(evaluate(rows, { callerKey: 'client-2', globalLimit: 1 })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_capacity',
      details: { reason: 'operationCapacity', capacityReturnsAt: held.expiresAt }
    })
    expect(evaluate(rows, { callerKey: 'client-2', perClientLimit: 1 }).decision).toBe('admit')
  })

  it('says capacity returns when the oldest counted row expires, and admits from then', () => {
    const HOUR = 60 * 60 * 1000
    const rows = new Map<string, AgentSessionOperationRow>()
    const oldest = admit(rows, {
      operationId: operationId(NOW - 2 * HOUR, 'b'.repeat(32)),
      now: NOW - 2 * HOUR
    })
    const newest = admit(rows, {
      operationId: operationId(NOW - HOUR, 'c'.repeat(32)),
      now: NOW - HOUR
    })
    expect(oldest.expiresAt).toBeLessThan(newest.expiresAt)
    for (const limits of [{ perClientLimit: 2 }, { callerKey: 'client-2', globalLimit: 2 }]) {
      expect(evaluate(rows, limits)).toEqual({
        decision: 'refused',
        code: 'agent_session_operation_capacity',
        details: { reason: 'operationCapacity', capacityReturnsAt: oldest.expiresAt }
      })
    }
    const later = oldest.expiresAt
    expect(
      evaluate(pruneAgentSessionOperationRows(rows, later), {
        perClientLimit: 2,
        now: later,
        operationId: operationId(later)
      }).decision
    ).toBe('admit')
  })

  it('says capacity returns when enough rows expire to get under a cap the ledger is over', () => {
    // Rows a build with a larger cap admitted, read by one with a smaller cap.
    const HOUR = 60 * 60 * 1000
    const rows = new Map<string, AgentSessionOperationRow>()
    const [oldest, middle] = [3, 2, 1].map((hoursAgo, index) =>
      admit(rows, {
        operationId: operationId(NOW - hoursAgo * HOUR, 'bcd'[index].repeat(32)),
        now: NOW - hoursAgo * HOUR
      })
    )
    for (const limits of [{ perClientLimit: 2 }, { callerKey: 'client-2', globalLimit: 2 }]) {
      expect(evaluate(rows, limits)).toEqual({
        decision: 'refused',
        code: 'agent_session_operation_capacity',
        details: { reason: 'operationCapacity', capacityReturnsAt: middle.expiresAt }
      })
    }
    for (const [at, decision] of [
      [oldest.expiresAt, 'refused'],
      [middle.expiresAt, 'admit']
    ] as const) {
      expect(
        evaluate(pruneAgentSessionOperationRows(rows, at), {
          perClientLimit: 2,
          now: at,
          operationId: operationId(at)
        }).decision
      ).toBe(decision)
    }
  })
})

describe('the pane a launch laid out', () => {
  const pane = { worktreeId: 'wt-1', paneKey: 'tab-1:leaf-1' }

  it('is recorded only by the claim that wins, and outlives the settle', () => {
    const id = operationId(NOW)
    const key = agentSessionOperationKey('caller', id)
    const pending = new Map([
      [
        key,
        pendingAgentSessionOperationRow({
          callerKey: 'caller',
          operationId: id,
          fingerprint: 'fp',
          now: NOW
        })
      ]
    ])

    const won = claimAgentSessionOperation(pending, {
      callerKey: 'caller',
      operationId: id,
      ownedPane: pane
    })
    expect(won.rows.get(key)?.ownedPane).toEqual(pane)
    const lost = claimAgentSessionOperation(won.rows, {
      callerKey: 'caller',
      operationId: id,
      ownedPane: { worktreeId: 'wt-1', paneKey: 'tab-2:leaf-2' }
    })
    expect(lost.claim.claim).toBe('lost')
    expect(lost.rows.get(key)?.ownedPane).toEqual(pane)

    const settled = settleAgentSessionOperation(won.rows, {
      callerKey: 'caller',
      operationId: id,
      outcome: { status: 'failed', code: 'boom' }
    })
    expect(settled.get(key)?.ownedPane).toEqual(pane)
    expect(isAgentSessionOperationRow(settled.get(key))).toBe(true)
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
  it('accepts every recorded outcome shape', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    expect(isAgentSessionOperationRow(row)).toBe(true)
    expect(
      isAgentSessionOperationRow({ ...row, outcome: { status: 'succeeded', sessionId: 's-1' } })
    ).toBe(true)
    expect(isAgentSessionOperationRow({ ...row, outcome: { status: 'unknown' } })).toBe(true)
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
    expect(isAgentSessionOperationRow({ ...row, outcome: null })).toBe(false)
    expect(isAgentSessionOperationRow(null)).toBe(false)
  })
})
