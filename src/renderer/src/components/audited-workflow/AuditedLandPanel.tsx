// The Phase 10 landing block: fast-forwarding the committed change into the
// user's own repository.
//
// Mounts for a `committed` task (where Land is offered), a `landing` task (where
// only an unknown outcome can be resolved), and a `landed` task (where the
// terminal result is shown).
//
// NOTHING IDENTIFYING IS RENDERED. No path, no branch, no full sha. The landed
// change appears solely as the 12-character landedShaShort.
//
// EXACTLY ONE PRIMARY ACTION, chosen by SERVER-COMPUTED booleans:
//   landReady            -> Land
//   landRecheckAvailable -> Recheck outcome   (outcome unknown; never Land)
// The renderer never derives which is legal, so it cannot offer Land for an
// unpublished commit or for an unconfirmed outcome.
//
// LANDING WRITES THE USER'S OWN WORKING TREE — the only place this feature does.
// That is why the action carries a confirmation step rather than firing directly.
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import type {
  AuditedWorkflowLandResult,
  AuditedWorkflowRecheckLandResult
} from '../../../../shared/audited-workflow-command-types'
import { getLandingAdvisoryMessage, getLandingErrorMessage } from './audited-landing-error-messages'
import { getWorktreeErrorMessage } from './audited-worktree-error-messages'

type Props = { task: AuditedTaskStatusProjection }

function describeLandFailure(result: Extract<AuditedWorkflowLandResult, { ok: false }>): string {
  return result.kind === 'landing'
    ? getLandingErrorMessage(result.reasonCode)
    : getWorktreeErrorMessage(result.reasonCode)
}

/**
 * Copy for a recheck verdict. The three durable outcomes all state that the land
 * SUCCEEDED, because the branch moved in every one of them.
 */
function describeRecheck(result: Extract<AuditedWorkflowRecheckLandResult, { ok: true }>): string {
  switch (result.classification) {
    case 'exact_completion':
      return translate(
        'auto.components.auditedWorkflow.landing.recheckCompleted',
        'The change is in your repository.'
      )
    case 'ref_moved':
    case 'ref_moved_worktree_partial':
      return result.advisory
        ? getLandingAdvisoryMessage(result.advisory)
        : translate(
            'auto.components.auditedWorkflow.landing.recheckMoved',
            'The change is in your repository.'
          )
    case 'no_effect':
      return translate(
        'auto.components.auditedWorkflow.landing.recheckNoEffect',
        'Nothing in your repository was changed. You can land again.'
      )
    case 'ambiguous':
      return translate(
        'auto.components.auditedWorkflow.landing.recheckAmbiguous',
        'Your repository is in an unexpected state, so this task is paused for review.'
      )
  }
}

export function AuditedLandPanel({ task }: Props): React.JSX.Element | null {
  const land = useAppStore((s) => s.landAuditedTask)
  const recheck = useAppStore((s) => s.recheckAuditedLand)
  const landPending = useAppStore((s) => s.auditedLandPendingTaskId) === task.taskId
  const recheckPending = useAppStore((s) => s.auditedLandRecheckPendingTaskId) === task.taskId

  // Transient command feedback. Not persisted, so it deliberately does not
  // survive a reload — the durable state is on the projection.
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  if (task.state !== 'committed' && task.state !== 'landing' && task.state !== 'landed') {
    return null
  }

  const handleLand = async (): Promise<void> => {
    setActionError(null)
    setActionNote(null)
    setConfirming(false)
    const result = await land(task.taskId)
    if (result.ok) {
      setActionNote(
        result.advisory
          ? getLandingAdvisoryMessage(result.advisory)
          : translate('auto.components.auditedWorkflow.landing.landed', 'Landed.')
      )
    } else {
      setActionError(describeLandFailure(result))
    }
  }

  const handleRecheck = async (): Promise<void> => {
    setActionError(null)
    setActionNote(null)
    const result = await recheck(task.taskId)
    if (result.ok) {
      setActionNote(describeRecheck(result))
    } else {
      setActionError(getLandingErrorMessage(result.reasonCode))
    }
  }

  const busy = landPending || recheckPending

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          {translate('auto.components.auditedWorkflow.landing.title', 'Land')}
        </span>
        {task.landedShaShort ? <Badge variant="secondary">{task.landedShaShort}</Badge> : null}
      </div>

      {/* An unconfirmed outcome states neither success nor failure. */}
      {task.landRecheckAvailable ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.auditedWorkflow.landing.outcomeUnknown',
            'Landing started, but the result has not been confirmed.'
          )}
        </p>
      ) : null}

      {task.landingAdvisoryCode && !task.landRecheckAvailable ? (
        <p className="text-xs text-muted-foreground">
          {getLandingAdvisoryMessage(task.landingAdvisoryCode)}
        </p>
      ) : null}

      {task.landingReasonCode && !task.landRecheckAvailable ? (
        <p className="text-xs text-muted-foreground">
          {getLandingErrorMessage(task.landingReasonCode)}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        {task.landReady && !confirming ? (
          <Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>
            {translate('auto.components.auditedWorkflow.landing.action', 'Land')}
          </Button>
        ) : null}

        {/* Landing writes the user's own files, so it is confirmed explicitly. */}
        {task.landReady && confirming ? (
          <>
            <span className="text-xs text-muted-foreground">
              {translate(
                'auto.components.auditedWorkflow.landing.confirmPrompt',
                'This updates your repository and its files.'
              )}
            </span>
            <Button size="sm" disabled={busy} onClick={() => void handleLand()}>
              {translate('auto.components.auditedWorkflow.landing.confirmAction', 'Confirm land')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {translate('auto.components.auditedWorkflow.landing.cancelAction', 'Cancel')}
            </Button>
          </>
        ) : null}

        {/* Offered exactly when Land is not: the two are mutually exclusive. */}
        {task.landRecheckAvailable ? (
          <Button size="sm" disabled={busy} onClick={() => void handleRecheck()}>
            {translate('auto.components.auditedWorkflow.landing.recheckAction', 'Recheck outcome')}
          </Button>
        ) : null}
      </div>

      {actionNote ? <p className="text-xs text-muted-foreground">{actionNote}</p> : null}
      {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
    </section>
  )
}
