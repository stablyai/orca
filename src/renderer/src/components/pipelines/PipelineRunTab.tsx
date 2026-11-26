import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { usePipelineWorkspace } from './use-pipeline-workspace'
import { pipelineRunTabAddress } from './pipeline-run-tab'
import { PipelineRunView } from './PipelineRunView'
import { PipelineManagerSheet } from './PipelineManagerSheet'

export function PipelineRunTab({
  worktreeId,
  runAddress
}: {
  worktreeId: string
  runAddress: string
}) {
  const t = useTranslate()
  const workspace = usePipelineWorkspace(worktreeId)
  const [manage, setManage] = useState(false)
  if (!workspace || pipelineRunTabAddress(workspace) !== runAddress) {
    return (
      <p className="p-6 text-sm">
        {t(
          'pipelines.runUnavailable',
          'This run is no longer attached to this workspace. Its saved history has not been changed.'
        )}
      </p>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <p className="text-xs text-muted-foreground">
            {t('pipelines.execution', 'Pipeline run')}
          </p>
          <h1 className="text-lg font-semibold">{workspace.displayName}</h1>
        </div>
        <Button variant="outline" onClick={() => setManage(true)}>
          {t('pipelines.templates', 'Templates')}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div className="mx-auto w-full max-w-5xl">
          <PipelineRunView workspace={workspace} />
        </div>
      </div>
      <PipelineManagerSheet
        projectId={workspace.pipeline.projectId}
        workspacePath={workspace.path}
        open={manage}
        onOpenChange={setManage}
      />
    </div>
  )
}
