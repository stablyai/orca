import { normalizeHostedReviewBaseRef as stripBaseRef } from '../../../../../../shared/source-control/hosted-review/hosted-review-refs'

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
