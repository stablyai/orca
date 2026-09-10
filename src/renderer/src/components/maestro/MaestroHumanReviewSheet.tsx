import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import type { MaestroHumanReview } from '../../../../shared/maestro-human-review'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { TechnicalDisclosure } from './MaestroRunProgressSections'
import type { MaestroHumanReviewTransitionInput } from './useMaestroHumanReview'

const APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1_000

type HumanReviewSheetProps = {
  review: MaestroHumanReview
  stateLabel: string
  onTransition: (request: MaestroHumanReviewTransitionInput) => Promise<void>
  onFocusBrowser: (review: MaestroHumanReview) => Promise<void>
}

function receiptId(action: string): string {
  return `${action}-${crypto.randomUUID()}`
}

function technicalEntries(review: MaestroHumanReview) {
  return [
    {
      label: translate('auto.components.maestro.MaestroHumanReview.review', 'Review'),
      value: review.review_id
    },
    {
      label: translate('auto.components.maestro.MaestroHumanReview.task', 'Task'),
      value: review.task_id
    },
    {
      label: translate('auto.components.maestro.MaestroHumanReview.dispatch', 'Dispatch'),
      value: review.dispatch_id
    },
    ...review.references.documents.map((document) => ({
      label: translate('auto.components.maestro.MaestroHumanReview.document', 'Document'),
      value: `${document.document_ref}@${document.revision}`
    })),
    ...review.references.fields.map((field) => ({
      label: translate('auto.components.maestro.MaestroHumanReview.field', 'Field'),
      value: `${field.document_ref}:${field.field_path}`
    })),
    ...(review.references.browser
      ? [
          {
            label: translate('auto.components.maestro.MaestroHumanReview.surface', 'Surface'),
            value: review.references.browser.surface_id
          },
          {
            label: translate('auto.components.maestro.MaestroHumanReview.page', 'Page'),
            value: review.references.browser.browser_page_id
          }
        ]
      : [])
  ]
}

export function HumanReviewSheet({
  review,
  stateLabel,
  onTransition,
  onFocusBrowser
}: HumanReviewSheetProps): React.JSX.Element {
  const [resolutions, setResolutions] = useState<Record<string, string>>({})
  const [submissionReference, setSubmissionReference] = useState('')
  const [rejectionReason, setRejectionReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const allDecisionsResolved = review.decisions.every((decision) =>
    resolutions[decision.decision_id]?.trim()
  )

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : translate(
              'auto.components.maestro.MaestroHumanReview.actionFailed',
              'Review action failed.'
            )
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <SheetContent
      className="scrollbar-sleek overflow-y-auto"
      aria-describedby="maestro-review-description"
    >
      <SheetHeader className="border-b border-border pr-12">
        <div className="flex items-center gap-2">
          <SheetTitle>{review.title}</SheetTitle>
          <Badge variant="outline">{stateLabel}</Badge>
        </div>
        <SheetDescription id="maestro-review-description">{review.summary}</SheetDescription>
      </SheetHeader>
      <div className="scrollbar-sleek flex-1 space-y-4 overflow-y-auto p-4">
        <ReviewReferences review={review} />
        {review.state === 'staged' || review.state === 'needs_input' ? (
          <DecisionForm review={review} resolutions={resolutions} onChange={setResolutions} />
        ) : null}
        {review.state === 'approved_for_submit' ? (
          <label className="block space-y-1.5 text-xs font-medium text-foreground">
            {translate(
              'auto.components.maestro.MaestroHumanReview.submissionReceiptReference',
              'Submission receipt reference'
            )}
            <Input
              value={submissionReference}
              onChange={(event) => setSubmissionReference(event.target.value)}
              placeholder={translate(
                'auto.components.maestro.MaestroHumanReview.submissionReceiptPlaceholder',
                'Receipt or confirmation reference…'
              )}
              spellCheck={false}
            />
          </label>
        ) : null}
        {['staged', 'needs_input', 'approved_for_submit'].includes(review.state) ? (
          <label className="block space-y-1.5 text-xs font-medium text-foreground">
            {translate(
              'auto.components.maestro.MaestroHumanReview.rejectionReason',
              'Rejection reason'
            )}
            <Textarea
              value={rejectionReason}
              onChange={(event) => setRejectionReason(event.target.value)}
              placeholder={translate(
                'auto.components.maestro.MaestroHumanReview.rejectionReasonPlaceholder',
                'Why this application cannot proceed…'
              )}
            />
          </label>
        ) : null}
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {review.references.browser ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void runAction(() => onFocusBrowser(review))}
            >
              <ExternalLink />{' '}
              {translate(
                'auto.components.maestro.MaestroHumanReview.browserFocus',
                'Browser Focus'
              )}
            </Button>
          ) : null}
          <ReviewPrimaryAction
            review={review}
            pending={pending}
            allDecisionsResolved={allDecisionsResolved}
            resolutions={resolutions}
            submissionReference={submissionReference}
            runAction={runAction}
            onTransition={onTransition}
          />
          {['staged', 'needs_input', 'approved_for_submit'].includes(review.state) ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || !rejectionReason.trim()}
              onClick={() =>
                void runAction(() =>
                  onTransition({
                    request_id: receiptId('reject-request'),
                    review_id: review.review_id,
                    action: 'reject',
                    receipt_id: receiptId('reject'),
                    reason: rejectionReason.trim()
                  })
                )
              }
            >
              {translate('auto.components.maestro.MaestroHumanReview.reject', 'Reject')}
            </Button>
          ) : null}
        </div>
        <ReceiptSummary review={review} />
        <TechnicalDisclosure entries={technicalEntries(review)} />
      </div>
    </SheetContent>
  )
}

function DecisionForm({
  review,
  resolutions,
  onChange
}: {
  review: MaestroHumanReview
  resolutions: Record<string, string>
  onChange: (value: Record<string, string>) => void
}): React.JSX.Element | null {
  if (review.decisions.length === 0) {
    return null
  }
  return (
    <fieldset className="space-y-3">
      <legend className="text-xs font-semibold text-foreground">
        {translate(
          'auto.components.maestro.MaestroHumanReview.decisionsRequired',
          'Decisions required'
        )}
      </legend>
      {review.decisions.map((decision) => (
        <label key={decision.decision_id} className="block space-y-1.5 text-xs text-foreground">
          {decision.prompt}
          <Textarea
            value={resolutions[decision.decision_id] ?? ''}
            onChange={(event) =>
              onChange({ ...resolutions, [decision.decision_id]: event.target.value })
            }
            placeholder={translate(
              'auto.components.maestro.MaestroHumanReview.decisionPlaceholder',
              'Record the human decision…'
            )}
          />
        </label>
      ))}
    </fieldset>
  )
}

function ReviewReferences({ review }: { review: MaestroHumanReview }): React.JSX.Element {
  return (
    <section
      aria-label={translate(
        'auto.components.maestro.MaestroHumanReview.reviewScope',
        'Review scope'
      )}
      className="space-y-2"
    >
      <h3 className="text-xs font-semibold text-foreground">
        {translate('auto.components.maestro.MaestroHumanReview.reviewScope', 'Review scope')}
      </h3>
      {[
        ...review.references.documents.map((entry) => entry.title),
        ...review.references.fields.map((entry) => entry.label)
      ].map((label) => (
        <p key={label} className="text-xs text-muted-foreground">
          {label}
        </p>
      ))}
      {review.references.browser ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.maestro.MaestroHumanReview.browserSurfaceAttached',
            'Exact Browser surface attached'
          )}
        </p>
      ) : null}
    </section>
  )
}

function ReviewPrimaryAction({
  review,
  pending,
  allDecisionsResolved,
  resolutions,
  submissionReference,
  runAction,
  onTransition
}: {
  review: MaestroHumanReview
  pending: boolean
  allDecisionsResolved: boolean
  resolutions: Record<string, string>
  submissionReference: string
  runAction: (action: () => Promise<void>) => Promise<void>
  onTransition: HumanReviewSheetProps['onTransition']
}): React.JSX.Element | null {
  if (review.state === 'staged' || review.state === 'needs_input') {
    return (
      <Button
        size="sm"
        disabled={pending || !allDecisionsResolved}
        onClick={() =>
          void runAction(() =>
            onTransition({
              request_id: receiptId('approve-request'),
              review_id: review.review_id,
              action: 'approve',
              receipt_id: receiptId('approve'),
              decision_resolutions: review.decisions.map((decision) => ({
                decision_id: decision.decision_id,
                resolution: (resolutions[decision.decision_id] ?? '').trim()
              })),
              expires_at: new Date(Date.now() + APPROVAL_LIFETIME_MS).toISOString()
            })
          )
        }
      >
        {translate(
          'auto.components.maestro.MaestroHumanReview.approveForSubmit',
          'Approve for submit'
        )}
      </Button>
    )
  }
  if (review.state !== 'approved_for_submit') {
    return null
  }
  return (
    <Button
      size="sm"
      disabled={pending || !submissionReference.trim()}
      onClick={() =>
        void runAction(() =>
          onTransition({
            request_id: receiptId('submit-request'),
            review_id: review.review_id,
            action: 'submit',
            receipt_id: receiptId('submit'),
            submission_reference: submissionReference.trim()
          })
        )
      }
    >
      {translate(
        'auto.components.maestro.MaestroHumanReview.recordSubmission',
        'Record submission'
      )}
    </Button>
  )
}

function ReceiptSummary({ review }: { review: MaestroHumanReview }): React.JSX.Element | null {
  const text = review.submission_receipt
    ? translate(
        'auto.components.maestro.MaestroHumanReview.submissionRecorded',
        'Submission recorded {{value0}}.',
        { value0: new Date(review.submission_receipt.recorded_at).toLocaleString() }
      )
    : review.approval_receipt
      ? translate(
          'auto.components.maestro.MaestroHumanReview.approvalRecorded',
          'Human approval recorded. Valid until {{value0}}.',
          { value0: new Date(review.approval_receipt.expires_at).toLocaleString() }
        )
      : review.rejection_receipt
        ? translate(
            'auto.components.maestro.MaestroHumanReview.rejectedWithReason',
            'Rejected: {{value0}}',
            { value0: review.rejection_receipt.reason }
          )
        : review.expiration_receipt
          ? translate(
              'auto.components.maestro.MaestroHumanReview.approvalExpiredBeforeSubmission',
              'The human approval expired before submission.'
            )
          : null
  return text ? (
    <p className="text-xs text-muted-foreground" role="status">
      {text}
    </p>
  ) : null
}
