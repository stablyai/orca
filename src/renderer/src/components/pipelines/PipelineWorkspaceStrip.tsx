import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { usePipelineWorkspace, type PipelineWorkspace } from './use-pipeline-workspace'
import { usePipelineRun } from './use-pipeline-run'
import { PipelineManagerSheet } from './PipelineManagerSheet'
import { pipelineRunStateLabel } from './pipeline-run-labels'
import { openPipelineRunTab } from './pipeline-run-tab'

export function PipelineWorkspaceStrip({
  worktreeId,
  visible
}: {
  worktreeId: string
  visible: boolean
}) {
  const workspace = usePipelineWorkspace(worktreeId, visible)
  return workspace ? (
    <WorkspacePipeline
      key={`${workspace.instanceId}:${workspace.pipeline.runId}`}
      workspace={workspace}
    />
  ) : null
}
function WorkspacePipeline({ workspace }: { workspace: PipelineWorkspace }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const model = usePipelineRun({
    projectId: workspace.pipeline.projectId,
    workspaceInstanceId: workspace.instanceId,
    runId: workspace.pipeline.runId
  })
  const run = model.read?.status.run
  const stage = model.read?.definition.stages.find((stage) => stage.id === run?.stageId)
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-1 text-foreground">
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 justify-start"
          onClick={() => openPipelineRunTab(workspace)}
        >
          <span className="truncate">
            {run
              ? `${stage?.title ?? run.definition.title} · ${pipelineRunStateLabel(run.state, t)}`
              : t('pipelines.loadingRun', 'Loading the pipeline…')}
          </span>
        </Button>
        {model.error && (
          <span role="status" className="text-xs text-destructive">
            {t('pipelines.readUnavailable', 'Progress is temporarily unavailable')}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={() => openPipelineRunTab(workspace)}>
          {t('pipelines.runDetails', 'Pipeline progress')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {t('pipelines.templates', 'Templates')}
        </Button>
      </div>
      <PipelineManagerSheet
        projectId={workspace.pipeline.projectId}
        workspacePath={workspace.path}
        open={open}
        onOpenChange={setOpen}
        onShowRun={() => {
          setOpen(false)
          openPipelineRunTab(workspace)
        }}
      />
    </>
  )
}
