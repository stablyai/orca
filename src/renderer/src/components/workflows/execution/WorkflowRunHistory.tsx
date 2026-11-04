import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { isWorkflowRunTerminal } from '../../../../../shared/workflow/workflow-run-types'
import { workflowRpc, type WorkflowRunSummary } from '../workflow-rpc'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import { useWorkflowRunViewStore } from '../workflow-run-view-store'
import { WORKFLOW_RUN_STATUS_LABEL, formatWorkflowDuration } from '../workflow-status-style'
import { useWorkflowClock } from '../use-workflow-clock'
import { getIntlLocale, translate } from '@/i18n/i18n'

export function WorkflowRunHistory({ target }: { target: RuntimeClientTarget }): React.JSX.Element {
  const presetId = useWorkflowEditorStore((state) => state.preset?.id)
  const setMode = useWorkflowEditorStore((state) => state.setMode)
  const watch = useWorkflowRunViewStore((state) => state.watch)
  const activeRunId = useWorkflowRunViewStore((state) => state.runId)
  const activeStatus = useWorkflowRunViewStore((state) => state.run?.status)
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null)
  const now = useWorkflowClock()
  const load = useCallback(() => {
    workflowRpc
      .listRuns(target, presetId)
      .then((result) => setRuns(result.runs))
      .catch((error: unknown) => {
        setRuns([])
        toast.error(
          translate(
            'auto.components.workflows.execution.WorkflowRunHistory.4d4365a36f',
            'Could not load run history'
          ),
          {
            description: error instanceof Error ? error.message : String(error)
          }
        )
      })
  }, [presetId, target])
  // Refetch when the watched run changes state, so new and finished runs appear.
  useEffect(load, [load, activeRunId, activeStatus])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-2xs text-muted-foreground">
          {translate(
            'auto.components.workflows.execution.WorkflowRunHistory.60a5c32c41',
            'Runs of this preset on this host, newest first. Each run keeps a frozen copy of the workflow it ran.'
          )}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
            'auto.components.workflows.execution.WorkflowRunHistory.f2a4dac740',
            'Refresh history'
          )}
          onClick={load}
        >
          <RefreshCw />
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {runs?.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
            {translate(
              'auto.components.workflows.execution.WorkflowRunHistory.3491ba357d',
              'No runs yet.'
            )}
          </li>
        ) : null}
        {runs?.map((run) => (
          <li
            key={run.id}
            className={cn(
              'group flex items-center gap-3 border-b border-border/60 px-3 py-1.5 text-xs hover:bg-accent',
              run.id === activeRunId && 'bg-accent'
            )}
            data-current={run.id === activeRunId || undefined}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              onClick={() => {
                watch(target, run.id)
                setMode('execution')
              }}
            >
              <span className="w-36 shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                {new Date(run.createdAt).toLocaleString(getIntlLocale())}
              </span>
              <span className="w-28 shrink-0 font-medium">
                {WORKFLOW_RUN_STATUS_LABEL[run.status]}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {run.error ?? run.objective}
              </span>
              <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                {run.startedAt
                  ? formatWorkflowDuration(
                      (run.settledAt ? Date.parse(run.settledAt) : now) - Date.parse(run.startedAt)
                    )
                  : ''}
              </span>
            </button>
            {/* Revealed on row hover or keyboard focus; the Button keeps its own effects. */}
            <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.workflows.execution.WorkflowRunHistory.cc689d7e44',
                  'Delete run history'
                )}
                disabled={!isWorkflowRunTerminal(run.status)}
                onClick={() =>
                  void workflowRpc
                    .deleteRun(target, run.id)
                    .then(load)
                    .catch((error: unknown) =>
                      toast.error(
                        translate(
                          'auto.components.workflows.execution.WorkflowRunHistory.b1896cfc1c',
                          'Delete failed'
                        ),
                        {
                          description: error instanceof Error ? error.message : String(error)
                        }
                      )
                    )
                }
              >
                <Trash2 />
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
