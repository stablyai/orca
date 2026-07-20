// Why: GitHub only aggregates completion one level at a time
// (Issue.subIssuesSummary covers direct children only, per the live
// introspection in the Phase 2 spike). A whole-subtree percentage across
// an arbitrarily-fetched depth has to be computed client-side. This
// function is depth-agnostic — it walks whatever `subIssues` was actually
// fetched and falls back to the node's own `subIssuesSummary` as the
// trusted terminal count for any branch that wasn't expanded further.

/** Minimal shape the rollup needs — a subset of GitHubIssueHierarchyNode,
 *  kept local so this module has no dependency on github-project-types.ts
 *  (pure, dependency-free utility). */
export type HierarchyRollupNode = {
  state: string
  subIssuesSummary: { total: number; completed: number; percentCompleted: number } | null
  subIssues: HierarchyRollupNode[]
}

export type HierarchyRollup = {
  totalDescendants: number
  completedDescendants: number
  percentCompleted: number
}

export function computeHierarchyRollup(node: HierarchyRollupNode): HierarchyRollup {
  if (node.subIssues.length === 0) {
    if (node.subIssuesSummary && node.subIssuesSummary.total > 0) {
      return {
        totalDescendants: node.subIssuesSummary.total,
        completedDescendants: node.subIssuesSummary.completed,
        percentCompleted: node.subIssuesSummary.percentCompleted
      }
    }
    return { totalDescendants: 0, completedDescendants: 0, percentCompleted: 0 }
  }

  let total = 0
  let completed = 0
  for (const child of node.subIssues) {
    total += 1
    if (child.state === 'CLOSED') {
      completed += 1
    }
    const childRollup = computeHierarchyRollup(child)
    total += childRollup.totalDescendants
    completed += childRollup.completedDescendants
  }

  return {
    totalDescendants: total,
    completedDescendants: completed,
    percentCompleted: total === 0 ? 0 : Math.round((completed / total) * 100)
  }
}
