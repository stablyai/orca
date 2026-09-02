import { LoaderCircle } from 'lucide-react'
import { TabsContent } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import { PipelineJobRow } from '../gitlab-item-dialog-parts'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'
import type { GitLabPipelineActions } from './use-gitlab-pipeline-actions'

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
  return (
    <TabsContent value="pipeline" className="mt-0">
      {loading && !details ? (
        <div className="flex items-center justify-center py-12">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : details?.pipelineJobs?.length ? (
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
      ) : (
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.GitLabItemDialog.f11e3e7675',
            'No pipeline runs for this MR.'
          )}
        </p>
      )}
    </TabsContent>
  )
}
