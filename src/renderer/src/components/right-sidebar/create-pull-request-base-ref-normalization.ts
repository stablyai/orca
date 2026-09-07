import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import { normalizeHostedReviewBaseRef } from '../../../../shared/hosted-review-refs'

export function stripBaseRef(ref: string): string {
  return normalizeHostedReviewBaseRef(ref)
}

export function resolveCreateReviewDefaultBaseRef({
  currentBaseRef,
  eligibilityDefaultBaseRef
}: {
  currentBaseRef?: string | null
  eligibilityDefaultBaseRef?: string | null
}): string {
  // Why: prefer the remote-validated main-process default over the worktree's
  // local parent base. For a stacked worktree whose parent is local-only,
  // `currentBaseRef` is that unpushable parent; the eligibility default has
  // already fallen back to a ref the remote can resolve. Fall back to
  // `currentBaseRef` only when eligibility supplied no default. Manual
  // `setUserBase` still wins via the base-resync suppression.
  return stripBaseRef(eligibilityDefaultBaseRef?.trim() || currentBaseRef?.trim() || '')
}

export function normalizeCreateReviewBaseSearchResults(
  results: readonly BaseRefSearchResult[]
): string[] {
  const seen = new Set<string>()
  const branches: string[] = []
  for (const result of results) {
    // Why: hosted review APIs take branch names, while base search displays
    // remote-qualified refs. Detailed search already resolves slashy remotes.
    const branch = stripBaseRef((result.localBranchName || result.refName).trim())
    if (!branch || seen.has(branch)) {
      continue
    }
    seen.add(branch)
    branches.push(branch)
  }
  return branches
}
