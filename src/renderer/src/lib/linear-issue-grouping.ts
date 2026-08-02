import type { LinearIssue } from '../../../shared/types'

export type LinearGroupSection = {
  key: string
  label: string
  issues: LinearIssue[]
}

// Linear workflow state.type rank: backlog first, terminal states last.
// Matches the ordering the Linear API already returns (states sorted by position).
const LINEAR_STATE_TYPE_RANK: Record<string, number> = {
  backlog: 0,
  started: 1,
  completed: 2,
  canceled: 3
}

const UNKNOWN_LINEAR_STATE_TYPE_RANK = 9

// Ordering only needs each section's workflow type; the section shape is kept generic so
// callers don't have to materialize a full LinearIssue. Returns a new array; input is not mutated.
type StatusRankableSection = {
  label: string
  issues: { state: { type: string } }[]
}

export function orderLinearStatusSections<T extends StatusRankableSection>(
  sections: T[]
): T[] {
  return [...sections].sort((a, b) => {
    const rankA = LINEAR_STATE_TYPE_RANK[a.issues[0]?.state.type ?? ''] ?? UNKNOWN_LINEAR_STATE_TYPE_RANK
    const rankB = LINEAR_STATE_TYPE_RANK[b.issues[0]?.state.type ?? ''] ?? UNKNOWN_LINEAR_STATE_TYPE_RANK
    return rankA - rankB || a.label.localeCompare(b.label)
  })
}

