import { useTranslate } from '@/i18n/use-translate'
import { useContext } from 'react'
import { PipelineSessionVisibility } from './pipeline-session-visibility'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePipelineWorkspace, type PipelineWorkspace } from './use-pipeline-workspace'
import { usePipelineRun } from './use-pipeline-run'
import { PipelineOwnerDecisionCard } from './PipelineOwnerDecisionCard'

type SessionAddress = { sessionId?: string; paneKey?: string }
export function PipelineSessionControls({
  worktreeId,
  sessionBinding,
  visible = true,
  compact = false
}: {
  worktreeId?: string | null
  sessionBinding: SessionAddress
  visible?: boolean
  compact?: boolean
}) {
  const chatVisible = useContext(PipelineSessionVisibility)
  const workspace = usePipelineWorkspace(worktreeId, visible && chatVisible)
  return workspace ? (
    <BoundPipelineSessionControls
      key={`${workspace.instanceId}:${workspace.pipeline.runId}`}
      workspace={workspace}
      sessionBinding={sessionBinding}
      compact={compact}
    />
  ) : null
}
function BoundPipelineSessionControls({
  workspace,
  sessionBinding,
  compact
}: {
  workspace: PipelineWorkspace
  sessionBinding: SessionAddress
  compact: boolean
}) {
  const t = useTranslate()
  const model = usePipelineRun({
    projectId: workspace.pipeline.projectId,
    workspaceInstanceId: workspace.instanceId,
    runId: workspace.pipeline.runId
  })
  const run = model.read?.status.run
  const actual = run?.currentInvocation?.session
  const matches =
    actual?.kind === 'structured'
      ? actual.sessionId === sessionBinding.sessionId
      : actual?.kind === 'terminal' &&
        Boolean(actual.paneKey && actual.paneKey === sessionBinding.paneKey)
  if (!matches || (!run?.pendingDecision && run?.waitReason !== 'session_sync')) {
    return null
  }
  return compact ? (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          {t('pipelines.ownerDecisionShort', 'Pipeline decision')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 max-w-[calc(100vw-2rem)]" align="end" wheelScroll>
        <div className="max-h-[70vh] overflow-y-auto scrollbar-sleek p-2">
          <PipelineOwnerDecisionCard model={model} inline />
        </div>
      </PopoverContent>
    </Popover>
  ) : (
    <div className="mx-4 my-2 max-h-72 shrink-0 overflow-y-auto scrollbar-sleek">
      <PipelineOwnerDecisionCard model={model} inline />
    </div>
  )
}
