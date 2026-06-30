import { describe, expect, it } from 'vitest'
import { resolveAppliedLabelIds, toggleLabelId } from './gitea-issue-label-toggle'

const repoLabels = [
  { id: 1, name: 'bug' },
  { id: 2, name: 'feature' }
]

describe('gitea issue label toggle', () => {
  it('keeps a label absent from the capped repo-label list when toggling another (#5493)', () => {
    // id 100 "security" is applied to the issue but not in repoLabels (an org
    // label, or one beyond the limit:100 page:1 fetch).
    const applied = resolveAppliedLabelIds([100, 1], ['security', 'bug'], repoLabels)
    const next = toggleLabelId(applied, 2) // turn "feature" on
    expect(next).toContain(100) // the org/capped label survives the update
    expect(next).toEqual([100, 1, 2])
  })

  it('removes a label by id while keeping the rest, including capped ones', () => {
    expect(toggleLabelId([100, 1, 2], 2)).toEqual([100, 1])
    expect(toggleLabelId([100, 1], 1)).toEqual([100])
  })

  it('falls back to resolving ids by name only when the issue ids have not loaded', () => {
    expect(resolveAppliedLabelIds([], ['bug'], repoLabels)).toEqual([1])
    // A name with no repo-label match cannot be resolved before the detail loads.
    expect(resolveAppliedLabelIds([], ['security'], repoLabels)).toEqual([])
  })

  it('prefers the issue ids over name resolution to avoid same-name collisions', () => {
    // The issue carries an org "bug" (id 5); the repo has a different "bug" (id 1).
    expect(resolveAppliedLabelIds([5], ['bug'], repoLabels)).toEqual([5])
  })
})
