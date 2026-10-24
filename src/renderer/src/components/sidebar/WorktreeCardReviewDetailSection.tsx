import type { MouseEvent } from 'react'
import { Link2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { WorktreeCardDetailSection } from './WorktreeCardDetailSection'
import { DetailHeader } from './WorktreeCardMetadataControls'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { getProviderName, getReviewLabel } from './worktree-review-helpers'
import { WorktreeCardReferenceRow } from './WorktreeCardReferenceRow'
import { WorktreeCardReviewActions } from './WorktreeCardReviewActions'
import { getWorkspaceAttachmentSourceLabel } from './workspace-attachment-source-label'

export function WorktreeCardReviewDetailSection({
  review,
  reviewMenuOpen,
  onReviewMenuOpenChange,
  onOpenReviewInOrca,
  onUnlinkReview,
  closeHover,
  onOpenLink,
  onManageLinks
}: {
  review: WorktreeCardPrDisplay | null
  reviewMenuOpen: boolean
  onReviewMenuOpenChange: (open: boolean) => void
  onOpenReviewInOrca?: (event: MouseEvent) => void
  onUnlinkReview?: () => void
  closeHover: () => void
  onOpenLink: (url: string, event: MouseEvent) => void
  onManageLinks?: (event: MouseEvent) => void
}): React.JSX.Element | null {
  if (!review) {
    return null
  }
  const label = getReviewLabel(review)
  const source =
    review.provider === 'unsupported'
      ? null
      : getWorkspaceAttachmentSourceLabel({
          provider: review.provider,
          type: label === 'MR' ? 'mr' : 'pr',
          number: review.number,
          url: review.url
        })
  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<Link2 className="size-3" />}
        label={`${translate('workspace.links.reviews', 'Reviews')} · 1`}
        onAddReference={onManageLinks}
      />
      <div className="py-1.5">
        <WorktreeCardReferenceRow
          review={review}
          kind={label === 'MR' ? 'mr' : 'pr'}
          title={review.title}
          label={`${label} ${label === 'MR' ? '!' : '#'}${review.number}`}
          provider={getProviderName(review)}
          source={source}
          url={review.url}
          onOpen={onOpenLink}
          actions={
            <WorktreeCardReviewActions
              label={label}
              number={review.number}
              provider={getProviderName(review)}
              open={reviewMenuOpen}
              onOpenChange={onReviewMenuOpenChange}
              onOpenInOrca={
                review.url && review.provider === 'github' ? onOpenReviewInOrca : undefined
              }
              onUnlink={onUnlinkReview}
              closeHover={closeHover}
            />
          }
        />
      </div>
    </WorktreeCardDetailSection>
  )
}
