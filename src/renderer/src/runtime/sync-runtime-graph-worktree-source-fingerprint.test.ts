import { beforeEach, describe, expect, it } from 'vitest'
import { canReuseMobileSessionSnapshot } from './sync-runtime-graph/mobile-session-capture'
import { buildMobileSessionWorktreeInputs } from './sync-runtime-graph/mobile-session-inputs'
import {
  collectMobileSessionWorktreeSourceRefs,
  mobileSessionWorktreeSourceRefsEqual
} from './sync-runtime-graph/mobile-session-worktree-sources'
import {
  DIRTY_WT,
  GATE_FILE,
  gateSideOf,
  makeGateState,
  resetPublicationCaches,
  type GateSide
} from './sync-runtime-graph-worktree-source-gate.test-support'
import { mutations } from './sync-runtime-graph-worktree-source-mutations.test-support'

/**
 * The gate's whole contract: equal source refs must imply the rebuild it skipped would have been a
 * no-op. Published content is the weaker oracle — a mutation the fingerprint misses can still land
 * on identical output in one fixture — so assert the invariant against `canReuseMobileSessionSnapshot`
 * itself.
 */

beforeEach(() => {
  resetPublicationCaches()
})

function inputsOf(side: GateSide): ReturnType<typeof buildMobileSessionWorktreeInputs> {
  return buildMobileSessionWorktreeInputs(side.state, DIRTY_WT, side.publication)
}

function refsOf(side: GateSide): ReturnType<typeof collectMobileSessionWorktreeSourceRefs> {
  return collectMobileSessionWorktreeSourceRefs(side.state, DIRTY_WT, side.publication)
}

describe('equal source refs imply the skipped rebuild would have been reusable', () => {
  for (const mutation of mutations) {
    it(`distinguishes ${mutation.name} from an unchanged frame`, () => {
      const { state } = makeGateState(4)
      const base = gateSideOf(state)
      const mutated = gateSideOf(mutation.apply(state))

      expect(canReuseMobileSessionSnapshot(inputsOf(base), inputsOf(mutated))).toBe(false)
      expect(mobileSessionWorktreeSourceRefsEqual(refsOf(base), refsOf(mutated))).toBe(false)
    })
  }
})

/**
 * Three fingerprint fields have a sibling that today always moves with them, so no store edit can
 * isolate one: `state.settings` feeds both `generatedTitlesEnabled` and `terminalTheme`, and
 * `getOpenFileIndexes` rebuilds `byWorktreeAndId` and `idsByWorktree` together. Each is therefore
 * redundant *given the current derivation*, and a suite that only mutates the store can never fail
 * on its deletion. Perturb the publication inputs instead: that record is what the collector is
 * declared over, and `canReuseMobileSessionSnapshot` already distinguishes every case below, so the
 * fingerprint being weaker than it is exactly the bug the gate must not have.
 */
describe('the fingerprint is never weaker than the reuse check it stands in for', () => {
  function withPublication(base: GateSide, publication: GateSide['publication']): GateSide {
    return { ...base, publication }
  }

  function expectDistinguished(base: GateSide, perturbed: GateSide): void {
    expect(canReuseMobileSessionSnapshot(inputsOf(base), inputsOf(perturbed))).toBe(false)
    expect(mobileSessionWorktreeSourceRefsEqual(refsOf(base), refsOf(perturbed))).toBe(false)
  }

  it('distinguishes the generated-title flag with the terminal theme held fixed', () => {
    const { state } = makeGateState(4)
    const base = gateSideOf(state)
    const perturbed = withPublication(base, {
      ...base.publication,
      generatedTitlesEnabled: true
    })

    expect(perturbed.publication.terminalTheme).toBe(base.publication.terminalTheme)
    expectDistinguished(base, perturbed)
  })

  it('distinguishes a saved open file with the id list held fixed', () => {
    const { state } = makeGateState(4)
    const base = gateSideOf(state)
    const { byWorktreeAndId, idsByWorktree } = base.publication.openFileIndexes
    const saved = new Map(
      [...(byWorktreeAndId.get(DIRTY_WT) ?? [])].map(([fileId, file]) => [
        fileId,
        { ...file, isDirty: false }
      ])
    )
    const perturbed = withPublication(base, {
      ...base.publication,
      openFileIndexes: {
        byWorktreeAndId: new Map([...byWorktreeAndId, [DIRTY_WT, saved]]),
        idsByWorktree
      }
    })

    expect(saved.get(GATE_FILE)?.isDirty).toBe(false)
    expect(perturbed.publication.openFileIndexes.idsByWorktree).toBe(idsByWorktree)
    expectDistinguished(base, perturbed)
  })

  it('distinguishes a replaced open-file id list with the file map held fixed', () => {
    const { state } = makeGateState(4)
    const base = gateSideOf(state)
    const { byWorktreeAndId, idsByWorktree } = base.publication.openFileIndexes
    const perturbed = withPublication(base, {
      ...base.publication,
      openFileIndexes: {
        byWorktreeAndId,
        idsByWorktree: new Map([
          ...idsByWorktree,
          [DIRTY_WT, [...(idsByWorktree.get(DIRTY_WT) ?? [])]]
        ])
      }
    })

    expect(perturbed.publication.openFileIndexes.byWorktreeAndId).toBe(byWorktreeAndId)
    expectDistinguished(base, perturbed)
  })
})
