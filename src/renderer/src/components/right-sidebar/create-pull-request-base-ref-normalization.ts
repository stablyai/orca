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
