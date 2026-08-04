// The Phase 9 publish block: sending the committed change to the remote and
// opening a review request.
//
// Mounts ONLY for a `committed` task (the publish lane never changes the task
// state) and for a task blocked out of it.
//
// NOTHING IDENTIFYING IS RENDERED. No path, no branch, no remote name, no URL,
// no full sha. The published change appears solely as the 12-character
// publishedShaShort, and the review as its number.
//
// EXACTLY ONE PRIMARY ACTION, chosen by SERVER-COMPUTED booleans:
//   publishReady            -> Publish
//   publishRecheckAvailable -> Recheck outcome   (outcome unknown; never Publish)
//   reviewRequestRetryAvailable -> Create review request
// The renderer never derives which is legal, so it cannot offer Publish for an
// unconfirmed outcome.
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import type {
  AuditedWorkflowPublishResult,
  AuditedWorkflowRecheckPublishResult
} from '../../../../shared/audited-workflow-command-types'
import { getPublishAdvisoryMessage, getPublishErrorMessage } from './audited-publish-error-messages'
import { getWorktreeErrorMessage } from './audited-worktree-error-messages'

type Props = { task: AuditedTaskStatusProjection }

function describePublishFailure(
  result: Extract<AuditedWorkflowPublishResult, { ok: false }>
): string {
  return result.kind === 'publish'
    ? getPublishErrorMessage(result.reasonCode)
    : getWorktreeErrorMessage(result.reasonCode)
}

/**
 * Copy for a recheck verdict. `unknown_remote` deliberately claims NEITHER
 * success nor failure — the honest statement is that the result is unconfirmed.
 */
function describeRecheck(
  result: Extract<AuditedWorkflowRecheckPublishResult, { ok: true }>
): string {
  switch (result.classification) {
    case 'published':
      return result.advisory
        ? getPublishAdvisoryMessage(result.advisory)
        : translate(
            'auto.components.auditedWorkflow.publish.recheckPublished',
            'The change is on the remote.'
          )
    case 'no_effect':
      return translate(
        'auto.components.auditedWorkflow.publish.recheckNoEffect',
        'The change never reached the remote. You can publish again.'
      )
    case 'ambiguous':
      return translate(
        'auto.components.auditedWorkflow.publish.recheckAmbiguous',
        'The remote is in an unexpected state, so this task is paused for review.'
      )
    case 'unknown_remote':
      return translate(
        'auto.components.auditedWorkflow.publish.recheckUnknown',
        'The remote is still unreachable, so the result is still unconfirmed.'
      )
  }
}

export function AuditedPublishPanel({ task }: Props): React.JSX.Element | null {
  const publish = useAppStore((s) => s.publishAuditedTask)
  const recheck = useAppStore((s) => s.recheckAuditedPublish)
  const createReview = useAppStore((s) => s.createAuditedReviewRequest)
  const publishPending = useAppStore((s) => s.auditedPublishPendingTaskId) === task.taskId
  const recheckPending = useAppStore((s) => s.auditedPublishRecheckPendingTaskId) === task.taskId
  const reviewPending = useAppStore((s) => s.auditedReviewRequestPendingTaskId) === task.taskId

  // Transient command feedback. Not persisted, so it deliberately does not
  // survive a reload — the durable state is on the projection.
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)

  if (task.state !== 'committed') {
    return null
  }

  const handlePublish = async (): Promise<void> => {
    setActionError(null)
    setActionNote(null)
    const result = await publish(task.taskId)
    if (result.ok) {
      setActionNote(result.advisory ? getPublishAdvisoryMessage(result.advisory) : null)
    } else {
      setActionError(describePublishFailure(result))
    }
  }

  const handleRecheck = async (): Promise<void> => {
    setActionError(null)
    setActionNote(null)
    const result = await recheck(task.taskId)
    if (result.ok) {
      setActionNote(describeRecheck(result))
    } else {
      setActionError(getPublishErrorMessage(result.reasonCode))
    }
  }

  const handleCreateReview = async (): Promise<void> => {
    setActionError(null)
    setActionNote(null)
    const result = await createReview(task.taskId)
    if (result.ok) {
      setActionNote(getPublishAdvisoryMessage(result.advisory))
    } else {
      setActionError(getPublishErrorMessage(result.reasonCode))
    }
  }

  const busy = publishPending || recheckPending || reviewPending

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          {translate('auto.components.auditedWorkflow.publish.title', 'Publish')}
        </span>
        {task.publishedShaShort ? (
          <Badge variant="secondary">{task.publishedShaShort}</Badge>
        ) : null}
        {task.reviewAvailable && task.reviewNumber !== null ? (
          <Badge variant="secondary">{`#${task.reviewNumber}`}</Badge>
        ) : null}
      </div>

      {/* An unconfirmed outcome states neither success nor failure. */}
      {task.publishRecheckAvailable ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.auditedWorkflow.publish.outcomeUnknown',
            'The change was sent, but the result has not been confirmed.'
          )}
        </p>
      ) : null}

      {task.publishAdvisoryCode && !task.publishRecheckAvailable ? (
        <p className="text-xs text-muted-foreground">
          {getPublishAdvisoryMessage(task.publishAdvisoryCode)}
        </p>
      ) : null}

      {task.publishReasonCode && !task.publishRecheckAvailable ? (
        <p className="text-xs text-muted-foreground">
          {getPublishErrorMessage(task.publishReasonCode)}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        {task.publishReady ? (
          <Button size="sm" disabled={busy} onClick={() => void handlePublish()}>
            {translate('auto.components.auditedWorkflow.publish.action', 'Publish')}
          </Button>
        ) : null}

        {/* Offered exactly when Publish is not: the two are mutually exclusive. */}
        {task.publishRecheckAvailable ? (
          <Button size="sm" disabled={busy} onClick={() => void handleRecheck()}>
            {translate('auto.components.auditedWorkflow.publish.recheckAction', 'Recheck outcome')}
          </Button>
        ) : null}

        {task.reviewRequestRetryAvailable ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void handleCreateReview()}
          >
            {translate(
              'auto.components.auditedWorkflow.publish.createReviewAction',
              'Create review request'
            )}
          </Button>
        ) : null}
      </div>

      {actionNote ? <p className="text-xs text-muted-foreground">{actionNote}</p> : null}
      {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
    </section>
  )
}
