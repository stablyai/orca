import { CircleDashed, ExternalLink, LoaderCircle } from 'lucide-react'
import { TabsContent } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import { PipelineJobRow } from '../gitlab-item-dialog-parts'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'
import type { GitLabPipelineActions } from './use-gitlab-pipeline-actions'
import { gitLabPipelineToPRCheck } from '../../../../shared/gitlab-pipeline-checks'
import { getCheckStatusLabel } from '@/components/github/pr-check-presentation'
import { CHECK_COLOR, CHECK_ICON } from '@/components/right-sidebar/checks-panel/check-presentation'
import { openAppHttpLinkFromAnchor } from '@/lib/app-http-link-open'

type Props = {
  item: GitLabWorkItem
  state: GitLabItemDialogState
  pipelineActions: GitLabPipelineActions
}

export function GitLabPipelineTab({ item, state, pipelineActions }: Props) {
  if (item.type !== 'mr') {
    return null
  }
  const { details, expandedJobId, jobTraceById, loading, retryingJobId } = state
  const pipelineCheck = details?.pipeline
    ? gitLabPipelineToPRCheck(
        details.pipeline,
        details.item.mergeable,
        translate('auto.components.GitLabItemDialog.02cbe2de44', 'Pipeline')
      )
    : null
  const PipelineIcon = CHECK_ICON[pipelineCheck?.conclusion ?? 'neutral'] ?? CircleDashed
  return (
    <TabsContent value="pipeline" className="mt-0">
      {loading && !details ? (
        <div className="flex items-center justify-center py-12">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-3">
          {pipelineCheck && (
            <div className="flex items-center gap-2 text-sm">
              <PipelineIcon
                className={`size-4 shrink-0 ${CHECK_COLOR[pipelineCheck.conclusion ?? 'neutral']}`}
              />
              {pipelineCheck.url ? (
                <a
                  href={pipelineCheck.url}
                  onClick={openAppHttpLinkFromAnchor}
                  className="flex min-w-0 items-center gap-1 text-foreground hover:text-muted-foreground"
                >
                  <span className="truncate">{pipelineCheck.name}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              ) : (
                <span>{pipelineCheck.name}</span>
              )}
              <span className="text-muted-foreground">{getCheckStatusLabel(pipelineCheck)}</span>
            </div>
          )}
          {details?.pipelineJobs?.length ? (
            <div className="space-y-1">
              {details.pipelineJobs.map((job) => (
                <PipelineJobRow
                  key={job.id}
                  job={job}
                  expanded={expandedJobId === job.id}
                  traceState={jobTraceById[job.id]}
                  retrying={retryingJobId === job.id}
                  onToggleTrace={(row) => void pipelineActions.handleToggleJobTrace(row)}
                  onRetry={(row) => void pipelineActions.handleRetryJob(row)}
                />
              ))}
            </div>
          ) : !pipelineCheck ? (
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.GitLabItemDialog.f11e3e7675',
                'No pipeline runs for this MR.'
              )}
            </p>
          ) : null}
        </div>
      )}
    </TabsContent>
  )
}
