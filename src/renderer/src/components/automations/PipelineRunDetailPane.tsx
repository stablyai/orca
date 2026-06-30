import React from 'react'
import { RefreshCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { PipelineRun, PipelineRunDetail } from '../../../../shared/pipelines-types'
import {
  canCancelPipelineRun,
  getPipelineRunStatusLabel,
  summarizePipelineRunDetail
} from './pipeline-panel-state'

type PipelineRunDetailPaneProps = {
  detail: PipelineRunDetail | null
  selectedRun: PipelineRun | null
  isLoading: boolean
  actionKey: string | null
  onCancel: () => void
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return 'Never'
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

function getLatestPlannerOutput(detail: PipelineRunDetail): string {
  const latest = [...detail.iterations]
    .reverse()
    .find((iteration) => iteration.plannerOutput !== null)
  if (!latest) {
    return 'No planner output recorded yet.'
  }
  return JSON.stringify(latest.plannerOutput, null, 2)
}

export function PipelineRunDetailPane({
  detail,
  selectedRun,
  isLoading,
  actionKey,
  onCancel
}: PipelineRunDetailPaneProps): React.JSX.Element {
  const detailSummary = detail ? summarizePipelineRunDetail(detail) : null
  return (
    <div className="min-h-0 rounded-md border border-border/50 bg-muted/20 shadow-sm">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {selectedRun ? selectedRun.id : 'Run detail'}
          </div>
          <div className="text-xs text-muted-foreground">
            {detailSummary
              ? `${detailSummary.iterations} iterations · ${detailSummary.tasks} tasks · ${detailSummary.logs} logs`
              : 'Select a run to inspect stages, tasks, logs, and errors.'}
          </div>
        </div>
        {selectedRun ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canCancelPipelineRun(selectedRun.status) || actionKey !== null}
            onClick={onCancel}
          >
            {actionKey === 'cancel' ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <X className="size-3.5" />
            )}
            Cancel
          </Button>
        ) : null}
      </div>

      {detail ? (
        <div className="scrollbar-sleek max-h-[calc(100vh-16rem)] overflow-auto p-3">
          <div className="grid gap-3 md:grid-cols-4">
            <DetailMetric label="Status" value={getPipelineRunStatusLabel(detail.run.status)} />
            <DetailMetric label="Iteration" value={String(detail.run.currentIteration)} />
            <DetailMetric label="Tasks" value={String(detail.tasks.length)} />
            <DetailMetric label="Errors" value={String(detailSummary?.errors ?? 0)} />
          </div>

          <DetailSection title="Planner output">
            <pre className="scrollbar-sleek max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-xs">
              {getLatestPlannerOutput(detail)}
            </pre>
          </DetailSection>

          <DetailSection title="Tasks">
            <div className="divide-y divide-border/50 rounded-md border border-border/50">
              {detail.tasks.map((task) => (
                <div key={task.id} className="grid gap-1 px-3 py-2 text-sm">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="truncate font-medium">{task.title}</div>
                    <Badge variant={task.status === 'failed' ? 'destructive' : 'outline'}>
                      {task.status}
                    </Badge>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {task.branch} · worktree {task.worktreeId ?? 'not created'} · terminal{' '}
                    {task.terminalIds[0] ?? 'none'}
                  </div>
                  {task.error ? (
                    <div className="text-xs text-destructive">{task.error.message}</div>
                  ) : null}
                </div>
              ))}
              {detail.tasks.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">No tasks planned.</div>
              ) : null}
            </div>
          </DetailSection>

          <DetailSection title="Stages">
            <div className="grid gap-2">
              {detail.stages.map((stage) => (
                <div
                  key={stage.id}
                  className="grid gap-1 rounded-md border border-border/50 bg-background px-3 py-2 text-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{stage.stage}</span>
                    <Badge variant={stage.status === 'failed' ? 'destructive' : 'outline'}>
                      {stage.status}
                    </Badge>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    worktree {stage.worktreeId ?? 'none'} · terminal {stage.terminalId ?? 'none'}
                  </div>
                  {stage.error ? (
                    <div className="text-xs text-destructive">{stage.error.message}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </DetailSection>

          <DetailSection title="Logs">
            <div className="grid gap-2">
              {detail.logs.slice(0, 30).map((log) => (
                <div
                  key={log.id}
                  className="rounded-md border border-border/50 bg-background px-3 py-2 text-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{log.message}</span>
                    <span className="text-xs uppercase text-muted-foreground">{log.level}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(log.createdAt)}
                  </div>
                </div>
              ))}
              {detail.logs.length === 0 ? (
                <div className="text-sm text-muted-foreground">No logs recorded.</div>
              ) : null}
            </div>
          </DetailSection>
        </div>
      ) : (
        <div className="flex min-h-[22rem] items-center justify-center px-3 text-sm text-muted-foreground">
          {isLoading ? 'Loading Pipeline runs...' : 'Select or start a Pipeline run.'}
        </div>
      )}
    </div>
  )
}

function DetailMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-border/50 bg-background px-3 py-2">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  )
}

function DetailSection({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-4">
      <div className="mb-2 text-sm font-medium">{title}</div>
      {children}
    </section>
  )
}
