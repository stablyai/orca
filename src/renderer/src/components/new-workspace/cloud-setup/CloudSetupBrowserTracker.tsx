// A6 "Finish in your browser": while the one setup tab is open, the panel ticks each step in place
// (from the setup session, or rows derived from billing until it exists), says why it stopped (X1)
// and keeps the way back to the browser one click away. The prompt stays editable above it.
import React from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { OrcaCloudSetupPanel } from '@/components/new-workspace/run-on/OrcaCloudSetupPanel'
import type {
  CloudSetupStep,
  CloudSetupStepId
} from '@/components/new-workspace/run-on/cloud-start-model'
import { reportCloudSetupProgress } from '@/lib/orca-cloud/cloud-setup-telemetry'
import { CloudSetupErrorNotice } from './CloudSetupErrorNotice'
import type { CloudSetupError, CloudSetupErrorAction } from './cloud-setup-errors'

export type CloudSetupBrowserTrackerProps = {
  steps: readonly CloudSetupStep[]
  /** Why setup stopped (X1), from the session's `error`; null while it's going. */
  error: CloudSetupError | null
  /** Members get "Ask an owner or admin…" instead of Choose plan on trial_unavailable. */
  canManageBilling?: boolean
  /** Setup session id, for telemetry only (never sent). Omit for derived rows. */
  sessionId?: string | null
  /** Ends the trip; finished steps stay done. */
  onCancel: () => void
  /** For a default browser that's the wrong one; hidden when there's no session link to copy. */
  onCopyLink?: () => void
  onReopen: () => void
  onErrorAction: (action: CloudSetupErrorAction) => void
  /** Per-row actions passed through to the panel (e.g. the Agent row's "Set up once"). */
  rowActions?: Partial<Record<CloudSetupStepId, React.ReactNode>>
  /** Trial → plan conversion context for telemetry. */
  afterTrial?: boolean
  className?: string
}

/**
 * Rows derived from billing (before the setup session reports its own) never say 'active'. While
 * the browser is open, the first unfinished required row is the one it's working on, so it reads
 * "In browser" rather than "Needed". Session rows that already mark a step active pass through.
 */
export function trackerSteps(
  steps: readonly CloudSetupStep[],
  stopped: boolean
): readonly CloudSetupStep[] {
  if (stopped || steps.some((step) => step.state === 'active')) {
    return steps
  }
  const index = steps.findIndex((step) => step.state === 'needed')
  if (index === -1) {
    return steps
  }
  return steps.map((step, i) => (i === index ? { ...step, state: 'active' } : step))
}

export function CloudSetupBrowserTracker({
  steps,
  error,
  canManageBilling = true,
  sessionId = null,
  onCancel,
  onCopyLink,
  onReopen,
  onErrorAction,
  rowActions,
  afterTrial = false,
  className
}: CloudSetupBrowserTrackerProps): React.JSX.Element {
  const t = useTranslate()
  const errorKind = error?.kind ?? null
  const rows = React.useMemo(() => trackerSteps(steps, error !== null), [steps, error])
  React.useEffect(() => {
    if (sessionId) {
      reportCloudSetupProgress(sessionId, rows, errorKind, { afterTrial })
    }
  }, [sessionId, rows, errorKind, afterTrial])
  // The error's own button already offers the browser for these; don't show it twice.
  const reopenInError = error !== null && (error.kind === 'timed_out' || error.kind === 'bank_step')
  return (
    <OrcaCloudSetupPanel
      steps={rows}
      title={t('components.newWorkspace.cloudSetup.trackerTitle', 'Finish in your browser')}
      subtitle={t(
        'components.newWorkspace.cloudSetup.trackerSubtitle',
        'Orca picks up each step the moment it’s done, then starts this workspace.'
      )}
      rowActions={rowActions}
      className={className}
    >
      {error ? (
        <CloudSetupErrorNotice
          error={error}
          canManageBilling={canManageBilling}
          onAction={onErrorAction}
          className="mt-2.5"
        />
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button type="button" variant="quiet" size="xs" onClick={onCancel}>
          {t('components.newWorkspace.cloudSetup.cancelSetup', 'Cancel setup')}
        </Button>
        <span className="ms-auto flex flex-wrap items-center gap-2">
          {onCopyLink ? (
            <Button type="button" variant="outline" size="xs" onClick={onCopyLink}>
              <Copy aria-hidden />
              {t('components.newWorkspace.cloudSetup.copySetupLink', 'Copy setup link')}
            </Button>
          ) : null}
          {reopenInError ? null : (
            <Button type="button" variant="outline" size="xs" onClick={onReopen}>
              {t('components.newWorkspace.cloudSetup.reopenBrowser', 'Reopen browser')}
              <ExternalLink aria-hidden />
            </Button>
          )}
        </span>
      </div>
    </OrcaCloudSetupPanel>
  )
}
