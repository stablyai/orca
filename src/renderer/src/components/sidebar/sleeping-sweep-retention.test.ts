import { describe, expect, it } from 'vitest'
import {
  createSleepingSweepRetentionState,
  SLEEPING_SWEEP_SETTLE_MS,
  updateSleepingSweepRetention
} from './sleeping-sweep-retention'

function runPass(
  state: ReturnType<typeof createSleepingSweepRetentionState>,
  activeIds: readonly string[],
  nowMs: number,
  candidates: readonly string[] = ['wt-a', 'wt-b']
): ReturnType<typeof updateSleepingSweepRetention> {
  const active = new Set(activeIds)
  return updateSleepingSweepRetention({
    state,
    candidateWorktreeIds: candidates,
    isActive: (id) => active.has(id),
    nowMs
  })
}

describe('sleeping sweep retention', () => {
  it('retains a workspace whose liveness drops for a single pass', () => {
    const state = createSleepingSweepRetentionState()
    runPass(state, ['wt-a', 'wt-b'], 1_000)

    // The PTY rebind commit: wt-a reads inactive for one pass.
    const dropped = runPass(state, ['wt-b'], 1_016)
    expect([...dropped.retainedIds]).toEqual(['wt-a'])

    // Rebind settles; the grace window closes with no visible change.
    const recovered = runPass(state, ['wt-a', 'wt-b'], 1_032)
    expect([...recovered.retainedIds]).toEqual([])
    expect(recovered.nextExpiryInMs).toBeNull()
  })

  it('sweeps once the workspace stays inactive past the settle window', () => {
    const state = createSleepingSweepRetentionState()
    runPass(state, ['wt-a'], 1_000)

    // The grace clock starts when the workspace first reads inactive, not when
    // it was last active — a quiet gap between passes must not eat the window.
    const during = runPass(state, [], 1_000)
    expect([...during.retainedIds]).toEqual(['wt-a'])
    expect(during.nextExpiryInMs).toBe(SLEEPING_SWEEP_SETTLE_MS)

    const after = runPass(state, [], 1_000 + SLEEPING_SWEEP_SETTLE_MS)
    expect([...after.retainedIds]).toEqual([])
    expect(after.nextExpiryInMs).toBeNull()
  })

  it('grants no grace to a workspace that was already asleep when first seen', () => {
    const state = createSleepingSweepRetentionState()
    const first = runPass(state, [], 1_000)
    expect([...first.retainedIds]).toEqual([])
    expect(first.nextExpiryInMs).toBeNull()
  })

  it('is idempotent across a double-invoked render at the same instant', () => {
    const state = createSleepingSweepRetentionState()
    runPass(state, ['wt-a'], 1_000)
    runPass(state, [], 2_000)
    const second = runPass(state, [], 2_000)

    expect([...second.retainedIds]).toEqual(['wt-a'])
    expect(second.nextExpiryInMs).toBe(SLEEPING_SWEEP_SETTLE_MS)
  })

  it('reports the soonest expiry when several windows are open', () => {
    const state = createSleepingSweepRetentionState()
    runPass(state, ['wt-a', 'wt-b'], 1_000)
    runPass(state, ['wt-b'], 1_100)
    const result = runPass(state, [], 1_200)

    expect([...result.retainedIds].sort()).toEqual(['wt-a', 'wt-b'])
    expect(result.nextExpiryInMs).toBe(SLEEPING_SWEEP_SETTLE_MS - 100)
  })

  it('drops grace state for a workspace that leaves the candidate set', () => {
    const state = createSleepingSweepRetentionState()
    runPass(state, ['wt-a'], 1_000)
    // wt-a is deleted; a later id reuse must not inherit its grace window.
    runPass(state, [], 1_100, ['wt-b'])
    const reused = runPass(state, [], 1_200, ['wt-a', 'wt-b'])

    expect([...reused.retainedIds]).toEqual([])
  })
})
