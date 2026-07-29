// Top-level view for Audited Workflow (plan §11). List | detail, following
// the Automations page template. Phase 1: list/detail backed by SQLite via
// IPC; no worktree provisioning, no model invocation, no Git mutation.
import { useEffect, useState } from 'react'
import { ArrowLeft, Plus, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { AuditedTaskSelectDialog } from './AuditedTaskSelectDialog'
import { AuditedTaskDetail } from './AuditedTaskDetail'
import {
  getAuditedTaskBadgeTone,
  getAuditedTaskStateLabel,
  sortAuditedTasksByRecency
} from './audited-task-row-state'
import { translate } from '@/i18n/i18n'

export default function AuditedWorkflowPage(): React.JSX.Element {
  const closeAuditedWorkflowPage = useAppStore((s) => s.closeAuditedWorkflowPage)
  const tasks = useAppStore((s) => s.auditedTasks)
  const tasksLoading = useAppStore((s) => s.auditedTasksLoading)
  const tasksError = useAppStore((s) => s.auditedTasksError)
  const selectedTaskId = useAppStore((s) => s.selectedAuditedTaskId)
  const selectAuditedTask = useAppStore((s) => s.selectAuditedTask)
  const refreshAuditedTasks = useAppStore((s) => s.refreshAuditedTasks)

  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  useEffect(() => {
    void refreshAuditedTasks()
  }, [refreshAuditedTasks])

  const sortedTasks = sortAuditedTasksByRecency(tasks)
  const selectedTask = sortedTasks.find((t) => t.taskId === selectedTaskId) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={closeAuditedWorkflowPage}
          className="shrink-0 gap-1.5"
        >
          <ArrowLeft className="size-3.5" />
          {translate('auto.components.auditedWorkflow.AuditedWorkflowPage.back', 'Back')}
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30">
            <ShieldCheck className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-base font-semibold text-foreground">
                {translate(
                  'auto.components.auditedWorkflow.AuditedWorkflowPage.title',
                  'Audited Workflow'
                )}
              </h1>
              <Badge variant="secondary">
                {translate('auto.components.auditedWorkflow.AuditedWorkflowPage.beta', 'Beta')}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {translate(
                'auto.components.auditedWorkflow.AuditedWorkflowPage.subtitle',
                'Human-gated plan review, code audit, approval, commit, and landing.'
              )}
            </p>
          </div>
        </div>
        <Button size="sm" className="shrink-0 gap-1.5" onClick={() => setCreateDialogOpen(true)}>
          <Plus className="size-3.5" />
          {translate('auto.components.auditedWorkflow.AuditedWorkflowPage.newTask', 'New Task')}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-72 shrink-0 overflow-y-auto border-r border-border scrollbar-sleek">
          {tasksError ? (
            // Why: an IPC failure must never render as an indistinguishable
            // empty list — always show a concise error with a retry action.
            <div className="flex flex-col items-start gap-2 p-4">
              <p className="text-xs text-destructive">{tasksError}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void refreshAuditedTasks()
                }}
              >
                {translate('auto.components.auditedWorkflow.AuditedWorkflowPage.retry', 'Retry')}
              </Button>
            </div>
          ) : tasksLoading && sortedTasks.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">
              {translate('auto.components.auditedWorkflow.AuditedWorkflowPage.loading', 'Loading…')}
            </p>
          ) : sortedTasks.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">
              {translate(
                'auto.components.auditedWorkflow.AuditedWorkflowPage.empty',
                'No audited tasks yet.'
              )}
            </p>
          ) : (
            <ul>
              {sortedTasks.map((task) => {
                const isSelected = task.taskId === selectedTaskId
                return (
                  <li key={task.taskId}>
                    <button
                      type="button"
                      onClick={() => selectAuditedTask(task.taskId)}
                      data-current={isSelected ? 'true' : undefined}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 border-b border-border/60 px-4 py-3 text-left transition-colors',
                        isSelected ? 'bg-accent' : 'hover:bg-accent'
                      )}
                    >
                      <span className="w-full truncate text-sm font-medium">{task.title}</span>
                      <Badge
                        variant={
                          getAuditedTaskBadgeTone(task.state) === 'blocked'
                            ? 'destructive'
                            : getAuditedTaskBadgeTone(task.state) === 'success'
                              ? 'default'
                              : getAuditedTaskBadgeTone(task.state) === 'progress'
                                ? 'secondary'
                                : 'outline'
                        }
                        className="text-[10px]"
                      >
                        {getAuditedTaskStateLabel(task.state)}
                      </Badge>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {selectedTask ? (
            <AuditedTaskDetail task={selectedTask} />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
              {translate(
                'auto.components.auditedWorkflow.AuditedWorkflowPage.selectPrompt',
                'Select a task to view its details.'
              )}
            </div>
          )}
        </div>
      </div>

      <AuditedTaskSelectDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </div>
  )
}
