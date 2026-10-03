import type { ReactNode } from 'react'
import { actionsDurationSeconds } from '../../../../shared/github/actions-duration'
import { formatNativeChatDuration } from '../../../../shared/native-chat-turn-status'
import { ActionsStatus } from '../right-sidebar/ActionsStatus'
import { useDelayedStatus } from '@/hooks/use-delayed-status'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { CheckRunJobs } from './CheckRunJobs'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { loadActionsDetailTab } from '@/store/github/actions-detail-tabs'
import { ArrowLeft } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { actionsRepositoryUrl, actionsUrl } from '../../../../shared/github/actions-web-url'

/** Reload editor-tab details through the request-generation fence used by other check-detail tabs. */
export function ActionsRunDetailsPanel({ file }: { file: OpenFile }): React.JSX.Element {
  return (
    <ActionsRunDetailsContent
      state={file.checkRunDetails}
      refresh={() => {
        void loadActionsDetailTab(useAppStore.getState, file.id)
      }}
      loadMore={() => {
        void loadActionsDetailTab(useAppStore.getState, file.id, true)
      }}
    />
  )
}

/** Share the run/job view between Tasks and editor tabs, retaining prior data during refreshes. */
export function ActionsRunDetailsContent({
  state,
  refresh,
  loadMore,
  onBack,
  artifacts
}: {
  state: OpenFile['checkRunDetails']
  refresh: () => void
  loadMore: () => void
  onBack?: () => void
  artifacts?: ReactNode
}): React.JSX.Element {
  const details = state?.details
  const showLoading = useDelayedStatus(state?.contextKey ?? '', state?.loading ? true : null, 150)
  const metadata = details?.actions
  const duration = actionsDurationSeconds(details)
  const workflowFile = metadata?.run.workflowPath?.split('@')[0].split('/').at(-1)
  const run = metadata?.run
  /** Open only credential-free HTTP(S) URLs accepted by the shared Actions URL validator. */
  const open = (url: string | null): void => {
    if (actionsUrl(url)) {
      void window.api.shell.openUrl(url!)
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-editor-surface">
      <div className="border-b border-border px-5 py-4">
        {onBack && (
          <Button variant="ghost" size="sm" className="mb-2" onClick={onBack}>
            <ArrowLeft className="size-4" />
            {translate('actions.back', 'Back to Actions')}
          </Button>
        )}
        <div className="flex items-start gap-3">
          <h1 className="min-w-0 flex-1 break-words text-base font-medium">
            {run?.displayTitle ?? state?.check.name}
          </h1>
          <Button variant="outline" size="sm" disabled={state?.loading} onClick={refresh}>
            {translate('actions.refresh', 'Refresh')}
          </Button>
        </div>
        {run && (
          <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
            <span>
              {run.name} · #{run.runNumber} · {translate('actions.attempt', 'Attempt')}{' '}
              {run.runAttempt} · <ActionsStatus status={run.conclusion ?? run.status} />
            </span>
            <span>
              {run.headBranch} · {run.headSha?.slice(0, 7)} · {run.event} · {run.actor}
            </span>
            <span>
              {translate('actions.created', 'Created')}{' '}
              {run.createdAt ? new Date(run.createdAt).toLocaleString() : '—'}
            </span>
            <span>
              {translate('actions.started', 'Started')}{' '}
              {run.runStartedAt ? new Date(run.runStartedAt).toLocaleString() : '—'}
            </span>
            {duration !== null && (
              <span>
                {translate('actions.duration', 'Duration')} {formatNativeChatDuration(duration)}
              </span>
            )}
            <span>
              {translate('actions.updated', 'Updated')}{' '}
              {run.updatedAt ? new Date(run.updatedAt).toLocaleString() : '—'}
            </span>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 scrollbar-sleek">
        {showLoading && (
          <p role="status" className="text-sm text-muted-foreground">
            {translate('actions.loadingDetails', 'Loading workflow details…')}
            {details && ` ${translate('actions.stale', 'Showing previous data.')}`}
          </p>
        )}
        {(state?.error || metadata?.jobsError) && (
          <div role="alert" className="space-y-2 break-words text-sm text-destructive">
            <p>{state?.error ?? metadata?.jobsError}</p>
            <Button variant="outline" size="sm" disabled={state?.loading} onClick={refresh}>
              {translate('actions.retry', 'Retry')}
            </Button>
          </div>
        )}
        {metadata?.logWarnings.length ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'actions.excerptUnavailable',
              'Some log excerpts are unavailable. Open the jobs on GitHub for full logs.'
            )}
          </p>
        ) : null}
        {artifacts}
        {details?.jobs.length ? (
          <CheckRunJobs
            jobs={details.jobs}
            hasFailedJobs={false}
            actionsStatusColors
            jobLinkLabel={translate('actions.openJob', 'Open job on GitHub')}
          />
        ) : (
          metadata &&
          !metadata.jobsError && (
            <p className="text-sm text-muted-foreground">
              {translate('actions.noJobs', 'No jobs are available for this attempt.')}
            </p>
          )
        )}
        {metadata?.hasNextPage && (
          <Button variant="outline" size="sm" disabled={state?.loading} onClick={loadMore}>
            {translate('actions.moreJobs', 'Load more jobs')}
          </Button>
        )}
        {metadata?.limitReached && (
          <p className="text-xs text-muted-foreground">
            {translate(
              'actions.jobsLimit',
              'Showing up to 1,000 jobs. Open the run on GitHub for the complete list.'
            )}
          </p>
        )}
      </div>
      {metadata && (
        <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => open(run?.htmlUrl ?? null)}>
            {translate('actions.openRun', 'Open run on GitHub')}
          </Button>
          {run?.headSha && (
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                open(
                  `${actionsRepositoryUrl(metadata.repository)}/commit/${encodeURIComponent(run.headSha!)}`
                )
              }
            >
              {translate('actions.openCommit', 'Open commit')}
            </Button>
          )}
          {workflowFile && (
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                open(
                  `${actionsRepositoryUrl(metadata.repository)}/actions/workflows/${encodeURIComponent(workflowFile)}`
                )
              }
            >
              {translate('actions.openWorkflow', 'Open workflow')}
            </Button>
          )}
          <Button
            variant="link"
            size="sm"
            onClick={() => open(`${actionsRepositoryUrl(metadata.repository)}/actions`)}
          >
            {translate('actions.openActions', 'Open Actions on GitHub')}
          </Button>
        </div>
      )}
    </div>
  )
}
