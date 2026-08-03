// Compile-level contract for ExecutionCommandResult's worktree arms.
//
// The assertions below are conditional types evaluated by `pnpm typecheck`; the
// runtime `expect`s only keep them inside a real test so the file cannot be
// deleted as dead code. This mirrors the existing idiom in
// shared/feature-interactions.test.ts.
//
// What this pins: `persisted` must be a LITERAL discriminant (`true` | `false`),
// not `boolean`. With `boolean` there is a single worktree arm, so narrowing on
// `result.persisted` selects nothing and a consumer that forgets to branch on it
// still compiles — which is exactly the bug that made a persisted start failure
// render as a transient "nothing was changed" message.
import { describe, expect, it } from 'vitest'
import type { ExecutionCommandResult } from './audited-workflow-command-types'
import type { WorktreeReasonCode } from './audited-worktree-types'

type WorktreeArm = Extract<ExecutionCommandResult, { kind: 'worktree' }>
type PersistedArm = Extract<WorktreeArm, { persisted: true }>
type FreshArm = Extract<WorktreeArm, { persisted: false }>

// Both arms must exist and be distinct — `persisted: boolean` collapses them.
type MissingPersistedArm = [PersistedArm] extends [never] ? 'missing' : never
type MissingFreshArm = [FreshArm] extends [never] ? 'missing' : never

// `persisted` must not widen back to `boolean` on either arm.
type PersistedIsLiteralTrue = PersistedArm['persisted'] extends true ? true : never
type FreshIsLiteralFalse = FreshArm['persisted'] extends false ? true : never
type PersistedIsNotBoolean = boolean extends PersistedArm['persisted'] ? 'widened' : never
type FreshIsNotBoolean = boolean extends FreshArm['persisted'] ? 'widened' : never

// Both arms must still carry the same closed reason vocabulary.
type ArmsShareReasonVocabulary = [
  Exclude<PersistedArm['reasonCode'], WorktreeReasonCode>,
  Exclude<FreshArm['reasonCode'], WorktreeReasonCode>
] extends [never, never]
  ? true
  : never

describe('ExecutionCommandResult worktree arms', () => {
  it('exposes persisted as a literal discriminant, not a boolean field', () => {
    const bothArmsExist: [MissingPersistedArm, MissingFreshArm] extends [never, never]
      ? true
      : never = true
    const literalsHold: [PersistedIsLiteralTrue, FreshIsLiteralFalse] extends [true, true]
      ? true
      : never = true
    const neitherWidened: [PersistedIsNotBoolean, FreshIsNotBoolean] extends [never, never]
      ? true
      : never = true
    const sharedVocabulary: ArmsShareReasonVocabulary = true

    expect(bothArmsExist).toBe(true)
    expect(literalsHold).toBe(true)
    expect(neitherWidened).toBe(true)
    expect(sharedVocabulary).toBe(true)
  })

  it('narrows to exactly one arm when a consumer branches on persisted', () => {
    // The renderer's real branch: only a FRESH reason becomes transient state.
    function classify(result: ExecutionCommandResult): 'transient' | 'projection' | 'other' {
      if (result.ok || result.kind !== 'worktree') {
        return 'other'
      }
      if (result.persisted) {
        // Narrowed to PersistedArm — assignable, proving the arm is reachable.
        const persistedOnly: PersistedArm = result
        return persistedOnly.persisted ? 'projection' : 'other'
      }
      const freshOnly: FreshArm = result
      return freshOnly.persisted === false ? 'transient' : 'other'
    }

    const fresh: ExecutionCommandResult = {
      ok: false,
      kind: 'worktree',
      reasonCode: 'head_moved_from_base_commit',
      persisted: false
    }
    const persisted: ExecutionCommandResult = {
      ok: false,
      kind: 'worktree',
      reasonCode: 'head_moved_from_base_commit',
      persisted: true
    }

    expect(classify(fresh)).toBe('transient')
    expect(classify(persisted)).toBe('projection')
    expect(classify({ ok: true })).toBe('other')
    expect(classify({ ok: false, kind: 'execution', reasonCode: 'lock_contended' })).toBe('other')
  })
})
