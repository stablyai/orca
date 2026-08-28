import type React from 'react'
import { Activity, CalendarClock, ExternalLink, ListTodo, Plus, Workflow } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function WorkLogFocusCard({
  focusEstimateHours,
  currentTaskLabel,
  taskSurfaceAvailable,
  taskProviderLabel,
  activeWorkspaceLabel,
  openTasksDisabled,
  onCapture,
  onOpenTasks,
  onOpenActivity
}: {
  focusEstimateHours: string
  currentTaskLabel: string
  taskSurfaceAvailable: boolean
  taskProviderLabel: string
  activeWorkspaceLabel: string
  openTasksDisabled: boolean
  onCapture: () => void
  onOpenTasks: () => void
  onOpenActivity: () => void
}): React.JSX.Element {
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Current focus</CardTitle>
        <CardDescription>
          The active worktree and the last task surface stay visible while you log time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <StatBox
            label="Badge estimate"
            value={focusEstimateHours}
            description="From the active workspace badge state."
          />
          <StatBox
            label="Task surface"
            value={currentTaskLabel}
            description={taskSurfaceAvailable ? `Linked as ${taskProviderLabel}` : 'No task detail is open.'}
          />
          <StatBox
            label="Active worktree"
            value={activeWorkspaceLabel}
            description="Track what the workspace did."
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onCapture}>
            <Plus className="size-4" />
            Capture badge block
          </Button>
          <Button type="button" variant="outline" onClick={onOpenTasks} disabled={openTasksDisabled}>
            <ExternalLink className="size-4" />
            Open tasks
          </Button>
          <Button type="button" variant="outline" onClick={onOpenActivity}>
            <Activity className="size-4" />
            Open activity
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function StatBox({
  label,
  value,
  description
}: {
  label: string
  value: string
  description: string
}): React.JSX.Element {
  const icon =
    label === 'Badge estimate' ? (
      <Workflow className="size-3.5" />
    ) : label === 'Task surface' ? (
      <ListTodo className="size-3.5" />
    ) : (
      <CalendarClock className="size-3.5" />
    )
  return (
    <div className="rounded-lg border border-border/60 bg-muted/25 p-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <Badge variant="outline" className="gap-1 px-1.5 py-0.5">
          {icon}
        </Badge>
        <div className="truncate text-sm font-medium">{value}</div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{description}</div>
    </div>
  )
}
