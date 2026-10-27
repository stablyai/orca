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
  // Prefer remote-validated defaults over local-only stack parents; manual base edits still win through resync suppression.
  return stripBaseRef(eligibilityDefaultBaseRef?.trim() || currentBaseRef?.trim() || '')
}

export function normalizeCreateReviewBaseSearchResults(
  results: readonly BaseRefSearchResult[]
): string[] {
  const seen = new Set<string>()
  const branches: string[] = []
  for (const result of results) {
    // APIs need branch names; detailed search resolves remote-qualified refs, including slash-containing remote names.
    const branch = stripBaseRef((result.localBranchName || result.refName).trim())
    if (!branch || seen.has(branch)) {
      continue
    }
    seen.add(branch)
    branches.push(branch)
  }
  return branches
}
