import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { setRuntimeEnvironmentConnectionGenerationForTests } from '@/store/slices/runtime-status'
import {
  ENVIRONMENT_ID,
  makeSnapshot,
  makeState,
  pendingSurface
} from './__fixtures__/web-session-terminal-orphan-recovery-regression-fixtures'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
import {
  clearRetainedTerminalRetirementProofsForTests,
  mergeRetainedTerminalRetirementProofs
} from './web-session-terminal-retirement-proof-ledger'

const TAB_ID = 'host-tab'
const LEAF_ID = 'leaf-1'
const HANDLE = 'term-retired'
const WORKTREE = 'repo::ledger'
const retired = {
  parentTabId: TAB_ID,
  leafId: LEAF_ID,
  ptyId: 'pty-retired',
  terminal: HANDLE,
  incarnationId: 'inc-retired'
}

function frame(
  snapshotVersion: number,
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return { ...makeSnapshot(WORKTREE, 'epoch', []), snapshotVersion, ...overrides }
}

describe('web session terminal retirement proof ledger', () => {
  beforeEach(() => clearRetainedTerminalRetirementProofsForTests())

  // Omitted proofs reset recreated worktrees even if removal was missed; negotiated delta hosts send [] when unchanged, which retains evidence.
  it('forgets on an absent field but keeps proofs on an empty delta', () => {
    mergeRetainedTerminalRetirementProofs(
      ENVIRONMENT_ID,
      frame(1, { retiredTerminalSurfaces: [retired] })
    )
    expect(
      mergeRetainedTerminalRetirementProofs(
        ENVIRONMENT_ID,
        frame(2, { retiredTerminalSurfaces: [] })
      ).retiredTerminalSurfaces
    ).toEqual([retired])
    const successor = frame(3)
    expect(mergeRetainedTerminalRetirementProofs(ENVIRONMENT_ID, successor)).toBe(successor)
    expect(
      mergeRetainedTerminalRetirementProofs(
        ENVIRONMENT_ID,
        frame(4, { retiredTerminalSurfaces: [] })
      ).retiredTerminalSurfaces
    ).toEqual([])
  })

  it('carries a proof sent once into later delta frames for the same worktree', () => {
    expect(
      mergeRetainedTerminalRetirementProofs(
        ENVIRONMENT_ID,
        frame(1, { retiredTerminalSurfaces: [retired] })
      ).retiredTerminalSurfaces
    ).toEqual([retired])
    expect(
      mergeRetainedTerminalRetirementProofs(
        ENVIRONMENT_ID,
        frame(2, { retiredTerminalSurfaces: [] })
      ).retiredTerminalSurfaces
    ).toEqual([retired])
    expect(
      mergeRetainedTerminalRetirementProofs(
        'other-environment',
        frame(3, { retiredTerminalSurfaces: [] })
      ).retiredTerminalSurfaces
    ).toEqual([])
  })

  it('forgets a proof once the host publishes its surface live again', () => {
    mergeRetainedTerminalRetirementProofs(
      ENVIRONMENT_ID,
      frame(1, { retiredTerminalSurfaces: [retired] })
    )
    const revived = mergeRetainedTerminalRetirementProofs(
      ENVIRONMENT_ID,
      frame(2, { tabs: [pendingSurface(TAB_ID, LEAF_ID, 'pty-new', 'term-new')] })
    )
    expect(revived.retiredTerminalSurfaces).toBeUndefined()
    expect(
      mergeRetainedTerminalRetirementProofs(ENVIRONMENT_ID, frame(3)).retiredTerminalSurfaces
    ).toBeUndefined()
  })

  // Key proofs by connection generation, advanced on runtimeId change, or restarted hosts’ reused handles can match predecessor evidence (runtime-status.test.ts).
  it('forgets everything on a removed frame and on a new host connection', () => {
    mergeRetainedTerminalRetirementProofs(
      ENVIRONMENT_ID,
      frame(1, { retiredTerminalSurfaces: [retired] })
    )
    mergeRetainedTerminalRetirementProofs(ENVIRONMENT_ID, {
      ...frame(2),
      removed: true
    } as RuntimeMobileSessionTabsResult)
    expect(
      mergeRetainedTerminalRetirementProofs(ENVIRONMENT_ID, frame(3)).retiredTerminalSurfaces
    ).toBeUndefined()

    mergeRetainedTerminalRetirementProofs(
      ENVIRONMENT_ID,
      frame(4, { retiredTerminalSurfaces: [retired] })
    )
    setRuntimeEnvironmentConnectionGenerationForTests(ENVIRONMENT_ID, 99)
    expect(
      mergeRetainedTerminalRetirementProofs(ENVIRONMENT_ID, frame(5)).retiredTerminalSurfaces
    ).toBeUndefined()
  })

  // Legacy full lists merge by exact-identity union like deltas; repeats are no-ops and remain host-bounded.
  it('treats a full list repeated by a legacy host as idempotent', () => {
    const proofs = Array.from({ length: 64 }, (_, index) => ({
      ...retired,
      leafId: `leaf-${index}`,
      terminal: `term-${index}`
    }))
    for (let version = 1; version <= 3; version += 1) {
      const full = frame(version, { retiredTerminalSurfaces: proofs })
      const merged = mergeRetainedTerminalRetirementProofs(ENVIRONMENT_ID, full)
      expect(merged).toBe(full)
      expect(merged.retiredTerminalSurfaces).toHaveLength(64)
    }
    // A host that rotated one identity past its cap: the client list stays at the cap too.
    const rotated = [...proofs.slice(1), { ...retired, leafId: 'leaf-new', terminal: 'term-new' }]
    const merged = mergeRetainedTerminalRetirementProofs(
      ENVIRONMENT_ID,
      frame(4, { retiredTerminalSurfaces: rotated })
    )
    expect(merged.retiredTerminalSurfaces).toHaveLength(64)
    expect(merged.retiredTerminalSurfaces?.at(-1)?.leafId).toBe('leaf-new')
  })

  // Legacy hosts omit only when no proofs remain, so forgetting on absence loses no evidence.
  it('matches legacy visibility against a full-list host that omits the field when empty', () => {
    const proofs = Array.from({ length: 3 }, (_, index) => ({
      ...retired,
      leafId: `leaf-${index}`,
      terminal: `term-${index}`
    }))
    const legacyHostFrames = [
      frame(1, { retiredTerminalSurfaces: proofs }),
      frame(2),
      frame(3, { retiredTerminalSurfaces: proofs })
    ]
    const visible = legacyHostFrames.map(
      (hostFrame) =>
        mergeRetainedTerminalRetirementProofs(ENVIRONMENT_ID, hostFrame).retiredTerminalSurfaces
    )
    // A legacy client sees exactly what the host sent, frame by frame.
    expect(visible).toEqual(legacyHostFrames.map((hostFrame) => hostFrame.retiredTerminalSurfaces))
  })

  it('returns the same frame object when the ledger adds nothing', () => {
    const untouched = frame(1)
    expect(mergeRetainedTerminalRetirementProofs(ENVIRONMENT_ID, untouched)).toBe(untouched)
    const carried = frame(2, { retiredTerminalSurfaces: [retired] })
    expect(mergeRetainedTerminalRetirementProofs(ENVIRONMENT_ID, carried)).toBe(carried)
  })
})

// Earlier proofs must retire panes on later delta frames without another host round-trip.
describe('orphan recovery over delta frames', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  it('retires a stale local pane from a proof delivered on an earlier frame', async () => {
    const state = makeState(WORKTREE, [{ leafId: LEAF_ID, handle: HANDLE }])
    const call = vi.fn()
    const first = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      frame(1, { retiredTerminalSurfaces: [retired] }),
      ENVIRONMENT_ID,
      { call: call as never }
    )
    expect(first?.tabs).toEqual([])

    const second = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      frame(2, { retiredTerminalSurfaces: [] }),
      ENVIRONMENT_ID,
      { call: call as never }
    )
    expect(second?.tabs).toEqual([])
    expect(second?.retiredTerminalSurfaces).toEqual([retired])
    expect(call).not.toHaveBeenCalled()
  })
})
