// Why: Phase 3 — opt-in tree mode nests a Project row under its parent when
// both are rows in the same rendered group. Kept separate from
// github-project-group-sort.ts so the flat grouping/sorting contract stays
// untouched (RFC risk #8: flat-row assumption extended informally over time).
import type { GitHubProjectRow } from './github-project-types'

export type ProjectRowTreeNode = {
  row: GitHubProjectRow
  depth: number
  children: ProjectRowTreeNode[]
}

// Why: join key is content.url, never content.number — numbers collide
// across repos in a multi-repo org Project; urls are globally unique and
// present on both the row and its parentIssue.
export function buildProjectRowTree(rows: GitHubProjectRow[]): ProjectRowTreeNode[] {
  const byUrl = new Map<string, GitHubProjectRow>()
  for (const row of rows) {
    // Why: draft issues / redacted items have no url and never become
    // nesting parents — they still appear as roots below.
    if (row.content.url) {
      byUrl.set(row.content.url, row)
    }
  }

  const childrenByParentUrl = new Map<string, GitHubProjectRow[]>()
  const roots: GitHubProjectRow[] = []
  for (const row of rows) {
    const parentUrl = row.content.parentIssue?.url
    const parent = parentUrl ? byUrl.get(parentUrl) : undefined
    // Why: a missing parent (filtered out, or not a Project item in this
    // view) and a self-reference both degrade to an unindented root.
    if (parentUrl != null && parent && parent !== row) {
      const siblings = childrenByParentUrl.get(parentUrl)
      if (siblings) {
        siblings.push(row)
      } else {
        childrenByParentUrl.set(parentUrl, [row])
      }
    } else {
      roots.push(row)
    }
  }

  // Why: mutual-parent cycles leave every member with an in-map parent, so
  // none is a root and the roots-only traversal silently drops them — the
  // intended cycle handling; no visited-set guard needed.
  const build = (row: GitHubProjectRow, depth: number): ProjectRowTreeNode => ({
    row,
    depth,
    children: (row.content.url ? (childrenByParentUrl.get(row.content.url) ?? []) : []).map(
      (child) => build(child, depth + 1)
    )
  })

  return roots.map((row) => build(row, 0))
}

export function flattenProjectRowTree(
  nodes: ProjectRowTreeNode[],
  collapsedRowIds: ReadonlySet<string>
): ProjectRowTreeNode[] {
  const result: ProjectRowTreeNode[] = []

  const visit = (node: ProjectRowTreeNode): void => {
    result.push(node)
    if (!collapsedRowIds.has(node.row.id)) {
      for (const child of node.children) {
        visit(child)
      }
    }
  }

  for (const node of nodes) {
    visit(node)
  }

  return result
}
