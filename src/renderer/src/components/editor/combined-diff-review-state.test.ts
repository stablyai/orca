import { describe, expect, it } from 'vitest'
import type { CombinedDiffReviewState } from '../../../../shared/types'
import {
  getViewedSectionKeys,
  isCombinedDiffFileReviewed,
  markCombinedDiffFileReviewed,
  markCombinedDiffFileUnreviewed,
  normalizeCombinedDiffReviewState,
  reconcileCombinedDiffReviewState
} from './combined-diff-review-state'

function state(files: CombinedDiffReviewState['files']): CombinedDiffReviewState {
  return { version: 1, updatedAt: 1, files }
}

describe('combined diff review state', () => {
  it('marks and unmarks files without tombstones', () => {
    const reviewed = markCombinedDiffFileReviewed(state({}), 'unstaged:src/a.ts', 'd1', 100)

    expect(reviewed.files['unstaged:src/a.ts']).toEqual({
      key: 'unstaged:src/a.ts',
      reviewedAt: 100,
      diffIdentity: 'd1'
    })

    const unreviewed = markCombinedDiffFileUnreviewed(reviewed, 'unstaged:src/a.ts', 200)

    expect(unreviewed.files).toEqual({})
    expect(unreviewed.updatedAt).toBe(200)
  })

  it('returns the same reference on no-op unreview and reconcile', () => {
    const initial = state({})

    expect(markCombinedDiffFileUnreviewed(initial, 'missing', 100)).toBe(initial)
    expect(reconcileCombinedDiffReviewState(initial, [], 100)).toBe(initial)
  })

  it('gates viewed keys and file state by matching identity', () => {
    const initial = state({
      'unstaged:src/a.ts': {
        key: 'unstaged:src/a.ts',
        reviewedAt: 100,
        diffIdentity: 'd1'
      }
    })

    expect(
      getViewedSectionKeys(initial, [{ key: 'unstaged:src/a.ts', diffIdentity: 'd1' }])
    ).toEqual(new Set(['unstaged:src/a.ts']))
    expect(
      getViewedSectionKeys(initial, [{ key: 'unstaged:src/a.ts', diffIdentity: 'd2' }])
    ).toEqual(new Set())
    expect(isCombinedDiffFileReviewed(initial.files['unstaged:src/a.ts'], 'd1')).toBe(true)
    expect(isCombinedDiffFileReviewed(initial.files['unstaged:src/a.ts'], 'd2')).toBe(false)
  })

  it('deletes present entries whose identity changed but keeps absent entries', () => {
    const initial = state({
      'unstaged:src/a.ts': {
        key: 'unstaged:src/a.ts',
        reviewedAt: 100,
        diffIdentity: 'old'
      },
      'unstaged:src/absent.ts': {
        key: 'unstaged:src/absent.ts',
        reviewedAt: 90,
        diffIdentity: 'kept'
      }
    })

    const reconciled = reconcileCombinedDiffReviewState(
      initial,
      [{ key: 'unstaged:src/a.ts', diffIdentity: 'new' }],
      200
    )

    expect(reconciled.files).toEqual({
      'unstaged:src/absent.ts': {
        key: 'unstaged:src/absent.ts',
        reviewedAt: 90,
        diffIdentity: 'kept'
      }
    })
    expect(reconciled.updatedAt).toBe(200)
  })

  it('cap-prunes the oldest absent entries without evicting present entries', () => {
    const files: CombinedDiffReviewState['files'] = {}
    for (let index = 0; index < 501; index += 1) {
      const key = `unstaged:src/${index}.ts`
      files[key] = { key, reviewedAt: index, diffIdentity: `d${index}` }
    }

    const reconciled = reconcileCombinedDiffReviewState(
      state(files),
      [{ key: 'unstaged:src/0.ts', diffIdentity: 'd0' }],
      1_000
    )

    expect(reconciled.files['unstaged:src/0.ts']).toBeDefined()
    expect(reconciled.files['unstaged:src/1.ts']).toBeUndefined()
    expect(Object.keys(reconciled.files)).toHaveLength(500)
  })

  it('normalizes malformed persisted state', () => {
    expect(
      normalizeCombinedDiffReviewState({
        version: 99,
        updatedAt: Number.NaN,
        files: {
          good: { key: 'good', reviewedAt: 100, diffIdentity: 'd1' },
          badTime: { key: 'badTime', reviewedAt: '100', diffIdentity: 'd2' },
          badIdentity: { key: 'badIdentity', reviewedAt: 200, diffIdentity: '' }
        }
      })
    ).toEqual({
      version: 1,
      updatedAt: undefined,
      files: {
        good: { key: 'good', reviewedAt: 100, diffIdentity: 'd1' }
      }
    })
  })
})
