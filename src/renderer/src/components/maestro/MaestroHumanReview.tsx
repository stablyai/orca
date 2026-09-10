import { Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { MaestroHumanReview as MaestroHumanReviewRecord } from '../../../../shared/maestro-human-review'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { HumanReviewSheet } from './MaestroHumanReviewSheet'
import type { MaestroHumanReviewTransitionInput } from './useMaestroHumanReview'

const STATE_LABELS: Record<MaestroHumanReviewRecord['state'], () => string> = {
  staged: () => translate('auto.components.maestro.MaestroHumanReview.stateStaged', 'Staged'),
  needs_input: () =>
    translate('auto.components.maestro.MaestroHumanReview.stateNeedsInput', 'Needs input'),
  approved_for_submit: () =>
    translate(
      'auto.components.maestro.MaestroHumanReview.stateApprovedForSubmit',
      'Approved for submit'
    ),
  submitted: () =>
    translate('auto.components.maestro.MaestroHumanReview.stateSubmitted', 'Submitted'),
  rejected: () => translate('auto.components.maestro.MaestroHumanReview.stateRejected', 'Rejected'),
  expired: () =>
    translate('auto.components.maestro.MaestroHumanReview.stateExpired', 'Approval expired')
}

export function urgentHumanReviewCount(reviews: readonly MaestroHumanReviewRecord[]): number {
  return reviews.filter((review) =>
    ['staged', 'needs_input', 'approved_for_submit', 'expired'].includes(review.state)
  ).length
}

type HumanReviewProps = {
  status: 'loading' | 'ready' | 'error'
  reviews: readonly MaestroHumanReviewRecord[]
  error: string | null
  onRefresh: () => Promise<void>
  onTransition: (request: MaestroHumanReviewTransitionInput) => Promise<void>
  onFocusBrowser: (review: MaestroHumanReviewRecord) => Promise<void>
}

export function MaestroHumanReview(props: HumanReviewProps): React.JSX.Element {
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null)
  const selectedReview = useMemo(
    () => props.reviews.find((review) => review.review_id === selectedReviewId) ?? null,
    [props.reviews, selectedReviewId]
  )

  return (
    <section
      className="space-y-1.5"
      aria-label={translate(
        'auto.components.maestro.MaestroHumanReview.applicationReview',
        'Application review'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate(
            'auto.components.maestro.MaestroHumanReview.applicationReview',
            'Application review'
          )}
        </h3>
        {props.status === 'ready' ? <Badge variant="outline">{props.reviews.length}</Badge> : null}
      </div>
      <HumanReviewList {...props} onSelect={setSelectedReviewId} />
      <Sheet
        open={selectedReview !== null}
        onOpenChange={(open) => !open && setSelectedReviewId(null)}
      >
        {selectedReview ? (
          <HumanReviewSheet
            review={selectedReview}
            stateLabel={STATE_LABELS[selectedReview.state]()}
            onTransition={props.onTransition}
            onFocusBrowser={props.onFocusBrowser}
          />
        ) : null}
      </Sheet>
    </section>
  )
}

function HumanReviewList(
  props: HumanReviewProps & { onSelect: (reviewId: string) => void }
): React.JSX.Element {
  if (props.status === 'loading') {
    return (
      <div
        className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <Loader2 className="size-3.5 animate-spin" />{' '}
        {translate(
          'auto.components.maestro.MaestroHumanReview.loadingReviewItems',
          'Loading review items…'
        )}
      </div>
    )
  }
  if (props.status === 'error') {
    return (
      <div className="rounded-md border border-border bg-muted/25 p-2 text-xs" role="alert">
        <p className="text-foreground">
          {translate(
            'auto.components.maestro.MaestroHumanReview.reviewItemsUnavailable',
            'Review items are unavailable.'
          )}
        </p>
        <p className="mt-0.5 text-muted-foreground">{props.error}</p>
        <Button className="mt-2" size="xs" variant="outline" onClick={() => void props.onRefresh()}>
          {translate('auto.components.maestro.MaestroHumanReview.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  if (props.reviews.length === 0) {
    return (
      <p className="py-1 text-xs text-muted-foreground">
        {translate(
          'auto.components.maestro.MaestroHumanReview.noApplicationsNeedReview',
          'No applications need review.'
        )}
      </p>
    )
  }
  return (
    <div className="divide-y divide-border/80 border-y border-border/80">
      {props.reviews.map((review) => (
        <button
          key={review.review_id}
          type="button"
          className="flex w-full items-start gap-2 px-1 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => props.onSelect(review.review_id)}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">
              {review.title}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {review.summary}
            </span>
          </span>
          <Badge variant="outline" className="shrink-0">
            {STATE_LABELS[review.state]()}
          </Badge>
        </button>
      ))}
    </div>
  )
}
