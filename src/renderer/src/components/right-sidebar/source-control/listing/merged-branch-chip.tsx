import React from 'react'
import { GitMerge } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import { hostedReviewNumberLabel } from '@/i18n/hosted-review-localized-copy'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'

/** Status only: says the review merged, never that these rows are the review's changes. */
export function MergedBranchChip({
  review
}: {
  review: Pick<HostedReviewInfo, 'provider' | 'number'>
}): React.JSX.Element {
  const t = useTranslate()
  const reviewMerged = t(
    'auto.components.right.sidebar.SourceControl.branchSectionReviewMerged',
    '{{review}} is merged',
    { review: hostedReviewNumberLabel(review, t) }
  )
  return (
    // Title is for mouse hover; screen readers get the sr-only text in the toggle's name.
    <Badge variant="mergedState" title={reviewMerged}>
      <GitMerge aria-hidden="true" />
      <span className="@max-[15rem]/section-header:sr-only">
        {t('auto.components.right.sidebar.SourceControl.branchSectionMerged', 'Merged')}
      </span>
      <span className="sr-only">{` · ${reviewMerged}`}</span>
    </Badge>
  )
}
