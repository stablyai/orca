import { useState } from 'react'
import { Loader2, Pause, Play, RotateCw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { isWorkflowRunTerminal } from '../../../../shared/workflow/workflow-run-types'
import { useWorkflowEditorStore } from './workflow-editor-store'
import { useWorkflowRunViewStore } from './workflow-run-view-store'
import { workflowRunActions } from './workflow-run-actions'
import { WORKFLOW_RUN_STATUS_LABEL } from './workflow-status-style'

export function WorkflowRunControls({ onRun }: { onRun: () => void }) {
  const confirm = useConfirmationDialog()
  const run = useWorkflowRunViewStore((state) => state.run)
  const execution = useWorkflowEditorStore((state) => state.mode === 'execution')
  const [busy, setBusy] = useState(false)
  const live = run && !isWorkflowRunTerminal(run.status)
  const act = async (action: () => Promise<boolean>): Promise<void> => {
    setBusy(true)
    await action()
    setBusy(false)
  }
  if (!execution || !run) {
    return (
      <Button size="sm" onClick={onRun}>
        <Play />
        {translate('auto.components.workflows.WorkflowToolbar.7eab02df1e', 'Run')}
      </Button>
    )
  }
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          'text-xs font-medium',
          run.status === 'failed' && 'text-destructive',
          run.status === 'completed' && 'text-status-success'
        )}
      >
        {WORKFLOW_RUN_STATUS_LABEL[run.status]}
      </span>
      {live && run.status !== 'cancelling' ? (
        run.schedulingPaused ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void act(workflowRunActions.resume)}
          >
            <Play />
            {translate('auto.components.workflows.WorkflowToolbar.545ac28cd8', 'Resume')}
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void act(workflowRunActions.pause)}
              >
                <Pause />
                {translate('auto.components.workflows.WorkflowToolbar.ef4d9f9f57', 'Pause')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate(
                'auto.components.workflows.WorkflowToolbar.9653282742',
                'Stop starting new tasks; running workers continue'
              )}
            </TooltipContent>
          </Tooltip>
        )
      ) : null}
      {live ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || run.status === 'cancelling'}
          onClick={() =>
            void confirm({
              title: translate(
                'auto.components.workflows.WorkflowToolbar.6754c2f7c0',
                'Cancel this run?'
              ),
              description: translate(
                'auto.components.workflows.WorkflowToolbar.086fe6e306',
                'Orca stops each running worker. Any it cannot prove stopped stay marked unconfirmed.'
              ),
              confirmLabel: 'Cancel run',
              cancelLabel: 'Keep running',
              confirmVariant: 'destructive'
            }).then((accepted) => {
              if (accepted) {
                void act(workflowRunActions.cancel)
              }
            })
          }
        >
          {run.status === 'cancelling' ? <Loader2 className="animate-spin" /> : <Square />}
          {translate('auto.components.workflows.WorkflowToolbar.c432a65899', 'Cancel')}
        </Button>
      ) : (
        <Button size="sm" onClick={onRun}>
          <RotateCw />
          {translate('auto.components.workflows.WorkflowToolbar.b05389e781', 'Run again')}
        </Button>
      )}
    </div>
  )
}
