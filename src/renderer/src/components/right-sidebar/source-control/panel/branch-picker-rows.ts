import {
  checkGitBranchName,
  type GitBranchNameRejection
} from '../../../../../../shared/git-branch-name'
import type {
  GitLocalBranchEntry,
  GitLocalBranchListing
} from '../../../../../../shared/git-local-branches'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'

export type BranchPickerRow =
  | {
      kind: 'branch'
      name: string
      isCurrent: boolean
      /**
       * Label of the workspace already holding this branch, or the raw path when
       * no workspace matches. Null when the branch is free — or when the host is
       * too old to report occupancy, in which case the checkout is attempted and
       * git's own refusal is what the user sees.
       */
      occupiedBy: string | null
    }
  | { kind: 'create'; name: string; rejection: GitBranchNameRejection | null }

function matchesQuery(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase())
}

/**
 * Rows for the Source Control branch picker: matching local branches, then a
 * create row when the typed name is not one of them.
 */
export function buildBranchPickerRows(args: {
  listing: GitLocalBranchListing | null
  query: string
  /** Worktree the picker is acting on; its own occupancy is "current", not a conflict. */
  worktreePath: string | null
  /** Display name per worktree path, so occupancy reads as a workspace, not a path. */
  worktreeLabelByPath?: ReadonlyMap<string, string>
}): BranchPickerRow[] {
  const { listing, query, worktreePath, worktreeLabelByPath } = args
  const trimmedQuery = query.trim()
  const rows: BranchPickerRow[] = []
  const selfPath = worktreePath ? normalizeRuntimePathForComparison(worktreePath) : null

  // Why: a host older than `entries` still sends `branches`; widen it to the same
  // shape with occupancy unknown rather than hiding those branches from the picker.
  const entries: readonly GitLocalBranchEntry[] =
    listing?.entries ?? listing?.branches.map((name): GitLocalBranchEntry => ({ name })) ?? []
  for (const entry of entries) {
    if (trimmedQuery.length > 0 && !matchesQuery(entry.name, trimmedQuery)) {
      continue
    }
    const entryPath = entry.worktreePath
      ? normalizeRuntimePathForComparison(entry.worktreePath)
      : null
    const occupiedElsewhere = entryPath !== null && entryPath !== selfPath
    rows.push({
      kind: 'branch',
      name: entry.name,
      isCurrent: entry.name === listing?.current,
      occupiedBy: occupiedElsewhere
        ? (worktreeLabelByPath?.get(entryPath) ?? entry.worktreePath ?? null)
        : null
    })
  }

  // Why: only offer creation for a name the listing does not already hold —
  // `checkout -b` on an existing branch fails, and offering it would read as a switch.
  const alreadyExists = entries.some((entry) => entry.name === trimmedQuery)
  if (trimmedQuery.length > 0 && !alreadyExists) {
    const check = checkGitBranchName(trimmedQuery)
    rows.push({
      kind: 'create',
      name: trimmedQuery,
      rejection: check.ok ? null : check.reason
    })
  }

  return rows
}
