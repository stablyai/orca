// Why: Phase 2 — GitHub only aggregates completion one level at a time
// (Issue.subIssuesSummary covers direct children only). A whole-subtree
// percentage across an arbitrarily-fetched depth has to be computed
// client-side; this pure function is depth-agnostic by design so the same
// logic works whether the drawer fetched 1, 2, or N levels — see
// docs/reference/2026-07-15-github-projects-hierarchy-phase2-plan.md.
import { describe, expect, it } from 'vitest'
import { computeHierarchyRollup, type HierarchyRollupNode } from './github-issue-hierarchy-rollup'

function node(overrides: Partial<HierarchyRollupNode> = {}): HierarchyRollupNode {
  return {
    state: 'OPEN',
    subIssuesSummary: null,
    subIssues: [],
    ...overrides
  }
}

describe('computeHierarchyRollup', () => {
  it('returns zero for a leaf node with no known children', () => {
    const result = computeHierarchyRollup(node())
    expect(result).toEqual({ totalDescendants: 0, completedDescendants: 0, percentCompleted: 0 })
  })

  it('trusts subIssuesSummary as the terminal count for an unexpanded branch', () => {
    // Why: the node's own subIssues array is empty (not fetched past the
    // depth cap), but GitHub's subIssuesSummary already tells us this
    // branch has 4 children, 2 completed — we must not silently report 0.
    const result = computeHierarchyRollup(
      node({ subIssuesSummary: { total: 4, completed: 2, percentCompleted: 50 } })
    )
    expect(result).toEqual({ totalDescendants: 4, completedDescendants: 2, percentCompleted: 50 })
  })

  it('counts one direct open child with no grandchildren as 1/1 open', () => {
    const result = computeHierarchyRollup(node({ subIssues: [node({ state: 'OPEN' })] }))
    expect(result).toEqual({ totalDescendants: 1, completedDescendants: 0, percentCompleted: 0 })
  })

  it('counts one direct closed child with no grandchildren as 1/1 completed', () => {
    const result = computeHierarchyRollup(node({ subIssues: [node({ state: 'CLOSED' })] }))
    expect(result).toEqual({ totalDescendants: 1, completedDescendants: 1, percentCompleted: 100 })
  })

  it('recurses two levels deep, counting every descendant exactly once', () => {
    // root
    //  - child A (OPEN), has 1 grandchild fetched: B (CLOSED)
    //  - child C (CLOSED), leaf
    const tree = node({
      subIssues: [
        node({
          state: 'OPEN',
          subIssues: [node({ state: 'CLOSED' })]
        }),
        node({ state: 'CLOSED' })
      ]
    })
    const result = computeHierarchyRollup(tree)
    // Descendants: A (open), B (closed), C (closed) = 3 total, 2 completed
    expect(result).toEqual({
      totalDescendants: 3,
      completedDescendants: 2,
      percentCompleted: 67
    })
  })

  it('mixes an expanded branch with an unexpanded branch correctly', () => {
    // root
    //  - child A (OPEN), expanded with 1 grandchild B (CLOSED)
    //  - child C (OPEN), NOT expanded but subIssuesSummary says 2 total, 1 completed
    const tree = node({
      subIssues: [
        node({ state: 'OPEN', subIssues: [node({ state: 'CLOSED' })] }),
        node({
          state: 'OPEN',
          subIssuesSummary: { total: 2, completed: 1, percentCompleted: 50 }
        })
      ]
    })
    const result = computeHierarchyRollup(tree)
    // A itself (1, open) + B (1, closed) + C itself (1, open) + C's unexpanded
    // subtree (2 total, 1 completed) = 5 total, 2 completed
    expect(result).toEqual({
      totalDescendants: 5,
      completedDescendants: 2,
      percentCompleted: 40
    })
  })

  it('rounds percentCompleted to the nearest integer', () => {
    const tree = node({
      subIssues: [node({ state: 'CLOSED' }), node({ state: 'OPEN' }), node({ state: 'OPEN' })]
    })
    const result = computeHierarchyRollup(tree)
    expect(result.totalDescendants).toBe(3)
    expect(result.completedDescendants).toBe(1)
    expect(result.percentCompleted).toBe(33)
  })
})
