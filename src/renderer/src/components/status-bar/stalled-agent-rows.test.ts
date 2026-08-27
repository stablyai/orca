import { describe, expect, it } from 'vitest'
import {
  selectStalledAgentRows,
  stalledAgentRowsCanContinue,
  type StalledAgentRowsState
} from './stalled-agent-rows'
import type { RateLimitState } from '../../../../shared/rate-limit-types'

const NOW = 1_700_000_000_000
const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF_A = '22222222-2222-4222-8222-222222222222'
const LEAF_B = '33333333-3333-4333-8333-333333333333'

function limits(usedPercent: number, resetsAt: number | null): RateLimitState {
  return {
    claude: {
      provider: 'claude',
      session: { usedPercent, windowMinutes: 300, resetsAt, resetDescription: null },
      weekly: null,
      updatedAt: 0,
      error: null,
      status: 'ok'
    }
  } as unknown as RateLimitState
}

function state(
  stalls: { leafId: string; cause: 'auth' | 'network' | 'rate-limit'; observedAt: number }[],
  rateLimits?: RateLimitState
): StalledAgentRowsState {
  return {
    agentStallByPaneKey: Object.fromEntries(
      stalls.map((stall) => [
        `${TAB}:${stall.leafId}`,
        {
          paneKey: `${TAB}:${stall.leafId}`,
          cause: stall.cause,
          signature: `${stall.cause} failure`,
          observedAt: stall.observedAt
        }
      ])
    ),
    agentStatusByPaneKey: Object.fromEntries(
      stalls.map((stall) => [`${TAB}:${stall.leafId}`, { agentType: 'claude' }])
    ),
    agentStallRecoveryLedgerByPaneKey: {},
    tabsByWorktree: { 'wt-1': [{ id: TAB }] },
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', name: 'feature-branch' }] },
    ...(rateLimits ? { rateLimits } : {})
  } as unknown as StalledAgentRowsState
}

describe('selectStalledAgentRows', () => {
  it('names each pane so the user can tell the agents apart', () => {
    const rows = selectStalledAgentRows(
      state([{ leafId: LEAF_A, cause: 'auth', observedAt: NOW - 1000 }]),
      NOW
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      paneKey: `${TAB}:${LEAF_A}`,
      worktreeId: 'wt-1',
      worktreeName: 'feature-branch',
      agentType: 'claude',
      cause: 'auth',
      blocked: false
    })
  })

  it('puts the longest-stalled agent first', () => {
    const rows = selectStalledAgentRows(
      state([
        { leafId: LEAF_B, cause: 'auth', observedAt: NOW - 1_000 },
        { leafId: LEAF_A, cause: 'network', observedAt: NOW - 60_000 }
      ]),
      NOW
    )

    expect(rows.map((row) => row.cause)).toEqual(['network', 'auth'])
  })

  it('blocks a rate-limited row until its window reopens', () => {
    const rows = selectStalledAgentRows(
      state([{ leafId: LEAF_A, cause: 'rate-limit', observedAt: NOW }], limits(100, NOW + 60_000)),
      NOW
    )

    expect(rows[0]).toMatchObject({ blocked: true, resetAt: NOW + 60_000 })
  })

  it('unblocks a rate-limited row once the window has reopened', () => {
    const rows = selectStalledAgentRows(
      state([{ leafId: LEAF_A, cause: 'rate-limit', observedAt: NOW }], limits(100, NOW - 1)),
      NOW
    )

    expect(rows[0].blocked).toBe(false)
  })

  it('keeps a rate-limited row blocked when no reset time is known', () => {
    // "Blocked, reset unknown" must not read as "ready to continue".
    const rows = selectStalledAgentRows(
      state([{ leafId: LEAF_A, cause: 'rate-limit', observedAt: NOW }]),
      NOW
    )

    expect(rows[0]).toMatchObject({ blocked: true, resetAt: null })
  })
})

describe('stalledAgentRowsCanContinue', () => {
  it('is false when every row is waiting on a window', () => {
    const rows = selectStalledAgentRows(
      state([{ leafId: LEAF_A, cause: 'rate-limit', observedAt: NOW }], limits(100, NOW + 60_000)),
      NOW
    )

    expect(stalledAgentRowsCanContinue(rows)).toBe(false)
  })

  it('is true as soon as one row can be continued', () => {
    const rows = selectStalledAgentRows(
      state([
        { leafId: LEAF_A, cause: 'rate-limit', observedAt: NOW },
        { leafId: LEAF_B, cause: 'auth', observedAt: NOW }
      ]),
      NOW
    )

    expect(stalledAgentRowsCanContinue(rows)).toBe(true)
  })
})

describe('recently continued rows', () => {
  function withLedger(lastAttemptAt: number): StalledAgentRowsState {
    return {
      ...state([]),
      agentStallRecoveryLedgerByPaneKey: {
        [`${TAB}:${LEAF_A}`]: { cause: 'auth', attempts: 1, lastAttemptAt }
      }
    } as unknown as StalledAgentRowsState
  }

  it('keeps a continued agent listed, so recovery is not invisible', () => {
    // Recovery deletes the stall the instant it lands; without this the status
    // bar blinks for seconds and agents appear to revive on their own.
    const rows = selectStalledAgentRows(withLedger(NOW - 5_000), NOW)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ continuedAt: NOW - 5_000, blocked: false })
  })

  it('drops a continued agent once it has aged out', () => {
    expect(selectStalledAgentRows(withLedger(NOW - 10 * 60_000), NOW)).toEqual([])
  })

  it('does not double-list a pane that stalled again', () => {
    const stillStalled = {
      ...state([{ leafId: LEAF_A, cause: 'auth', observedAt: NOW }]),
      agentStallRecoveryLedgerByPaneKey: {
        [`${TAB}:${LEAF_A}`]: { cause: 'auth', attempts: 1, lastAttemptAt: NOW - 5_000 }
      }
    } as unknown as StalledAgentRowsState
    const rows = selectStalledAgentRows(stillStalled, NOW)

    expect(rows).toHaveLength(1)
    expect(rows[0].continuedAt).toBeNull()
  })

  it('sorts agents still waiting ahead of ones already continued', () => {
    const mixed = {
      ...state([{ leafId: LEAF_B, cause: 'auth', observedAt: NOW }]),
      agentStallRecoveryLedgerByPaneKey: {
        [`${TAB}:${LEAF_A}`]: { cause: 'auth', attempts: 1, lastAttemptAt: NOW - 60_000 }
      }
    } as unknown as StalledAgentRowsState

    expect(selectStalledAgentRows(mixed, NOW).map((row) => row.continuedAt === null)).toEqual([
      true,
      false
    ])
  })

  it('never offers Continue all for history alone', () => {
    expect(stalledAgentRowsCanContinue(selectStalledAgentRows(withLedger(NOW), NOW))).toBe(false)
  })
})
