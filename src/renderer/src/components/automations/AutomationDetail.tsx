import React from 'react'
import { Pencil, Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { Worktree } from '../../../../shared/types'
import { parseAutomationRrule } from '../../../../shared/automation-schedules'
import {
  formatAutomationDateTime,
  formatAutomationDateTimeWithRelative,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from './automation-page-parts'
import {
  formatAutomationCost,
  formatAutomationTokens,
  getAutomationUsageStatusLabel,
  summarizeAutomationRunUsage
} from './automation-usage-model'

type AutomationDetailProps = {
  automation: Automation | null
  runs: AutomationRun[]
  projectName: string
  workspaceName: string
  projectDefaultBaseRef: string | null
  worktreeMap: Map<string, Worktree>
  now: number
  onRunNow: (automation: Automation) => void
  onOpenRunWorkspace: (run: AutomationRun) => void
  onEdit: (automation: Automation) => void
  onToggle: (automation: Automation) => void
  onDelete: (automation: Automation) => void
}

function DetailMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  )
}

function formatTime(hour: number, minute: number): string {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function formatGrace(minutes: number): string {
  if (minutes <= 0) {
    return 'No grace'
  }
  if (minutes < 60) {
    return `${minutes} minutes`
  }
  const hours = minutes / 60
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

function formatSchedule(rrule: string): string {
  const schedule = parseAutomationRrule(rrule)
  if (schedule.preset === 'hourly') {
    return `Hourly at :${String(schedule.minute).padStart(2, '0')}`
  }
  const time = formatTime(schedule.hour, schedule.minute)
  if (schedule.preset === 'daily') {
    return `Daily at ${time}`
  }
  if (schedule.preset === 'weekdays') {
    return `Weekdays at ${time}`
  }
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(
    new Date(2026, 0, 4 + schedule.dayOfWeek)
  )
  return `${day}s at ${time}`
}

function ToolbarIconButton({
  label,
  children,
  onClick,
  className
}: {
  label: string
  children: React.ReactNode
  onClick: () => void
  className?: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
          className={className}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function AutomationDetail({
  automation,
  runs,
  projectName,
  workspaceName,
  projectDefaultBaseRef,
  worktreeMap,
  now,
  onRunNow,
  onOpenRunWorkspace,
  onEdit,
  onToggle,
  onDelete
}: AutomationDetailProps): React.JSX.Element {
  if (!automation) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Create an automation to start scheduling agent work.
      </div>
    )
  }
  const usageSummary = summarizeAutomationRunUsage(runs)
  const usageCoverage =
    usageSummary.knownRuns > 0
      ? `${usageSummary.knownRuns}/${runs.length} runs`
      : usageSummary.unavailableRuns > 0
        ? 'Unavailable'
        : 'No runs'

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-start justify-between gap-4 border-b border-border/50 pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{automation.name}</h2>
            <Badge variant={automation.enabled ? 'secondary' : 'outline'}>
              {automation.enabled ? 'Enabled' : 'Paused'}
            </Badge>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {projectName} / {workspaceName}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => onRunNow(automation)}>
            <Play className="size-4" />
            Run Now
          </Button>
          <ToolbarIconButton label="Edit automation" onClick={() => onEdit(automation)}>
            <Pencil className="size-4" />
          </ToolbarIconButton>
          <ToolbarIconButton
            label={automation.enabled ? 'Pause automation' : 'Resume automation'}
            onClick={() => onToggle(automation)}
          >
            {automation.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
          </ToolbarIconButton>
          <ToolbarIconButton
            label="Delete automation"
            onClick={() => onDelete(automation)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </ToolbarIconButton>
        </div>
      </div>

      {automation.executionTargetType === 'ssh' ? (
        <div className="rounded-md border border-border/50 bg-muted/50 p-3 text-sm text-muted-foreground shadow-sm">
          This SSH automation runs only while Orca can reach the SSH host. If reconnect needs
          interactive credentials or the host is unavailable, the run is recorded as skipped.
        </div>
      ) : null}

      <div className="grid grid-cols-6 gap-6 rounded-md border border-border/50 bg-muted/30 px-4 py-3 shadow-sm">
        <DetailMetric
          label="Next run"
          value={
            automation.enabled
              ? formatAutomationDateTimeWithRelative(automation.nextRunAt, now)
              : 'Paused'
          }
        />
        <DetailMetric
          label="Last run"
          value={formatAutomationDateTimeWithRelative(automation.lastRunAt, now)}
        />
        <DetailMetric
          label="Est. spend"
          value={formatAutomationCost(usageSummary.estimatedCostUsd)}
        />
        <DetailMetric label="Tokens" value={formatAutomationTokens(usageSummary.totalTokens)} />
        <DetailMetric label="Usage coverage" value={usageCoverage} />
        <DetailMetric label="Grace" value={formatGrace(automation.missedRunGraceMinutes)} />
      </div>

      <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
        <div className="border-b border-border/50 px-3 py-2 text-sm font-medium">Configuration</div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-6 gap-y-4 px-3 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase text-muted-foreground">Agent</div>
            <div className="mt-1 flex min-w-0 items-center gap-2 text-sm font-medium">
              <AgentIcon agent={automation.agentId} size={16} />
              <span className="truncate">
                {AGENT_CATALOG.find((agent) => agent.id === automation.agentId)?.label ??
                  automation.agentId}
              </span>
            </div>
          </div>
          <DetailMetric label="Schedule" value={formatSchedule(automation.rrule)} />
          <DetailMetric
            label={automation.workspaceMode === 'new_per_run' ? 'Create from' : 'Workspace'}
            value={
              automation.workspaceMode === 'new_per_run'
                ? (automation.baseBranch ?? projectDefaultBaseRef ?? 'Project default')
                : workspaceName
            }
          />
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase text-muted-foreground">Prompt</div>
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm text-foreground">
              {automation.prompt}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
        <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
          <div className="text-sm font-medium">Run history</div>
          <div className="text-xs text-muted-foreground">{runs.length} runs</div>
        </div>
        <div className="grid grid-cols-[minmax(9rem,1fr)_minmax(11rem,1.2fr)_minmax(5rem,.55fr)_minmax(5rem,.55fr)_minmax(6rem,auto)] gap-3 border-b border-border/50 px-3 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">
          <div>Run</div>
          <div>Workspace</div>
          <div>Spend</div>
          <div>Tokens</div>
          <div>Status</div>
        </div>
        <div className="divide-y divide-border/50">
          {runs.map((run) => {
            const runWorktree = run.workspaceId ? (worktreeMap.get(run.workspaceId) ?? null) : null
            const workspaceLabel = run.workspaceId
              ? (runWorktree?.displayName ?? 'Missing workspace')
              : 'Not launched'
            const rowClassName =
              'grid grid-cols-[minmax(9rem,1fr)_minmax(11rem,1.2fr)_minmax(5rem,.55fr)_minmax(5rem,.55fr)_minmax(6rem,auto)] items-center gap-3 px-3 py-2 text-left text-sm outline-none transition-colors'
            const usageLabel = getAutomationUsageStatusLabel(run.usage)
            const rowContent = (
              <>
                <div className="min-w-0">
                  <div>{formatAutomationDateTime(run.scheduledFor)}</div>
                  {run.error || run.usage?.status === 'unavailable' ? (
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {run.error ?? run.usage?.unavailableMessage}
                    </div>
                  ) : null}
                </div>
                <div
                  className={
                    runWorktree
                      ? 'min-w-0 truncate text-foreground'
                      : 'min-w-0 truncate text-muted-foreground'
                  }
                >
                  {workspaceLabel}
                </div>
                <div
                  className={
                    run.usage?.status === 'known'
                      ? 'text-sm tabular-nums'
                      : 'text-sm text-muted-foreground'
                  }
                  title={usageLabel}
                >
                  {formatAutomationCost(run.usage?.estimatedCostUsd)}
                </div>
                <div
                  className={
                    run.usage?.status === 'known'
                      ? 'text-sm tabular-nums'
                      : 'text-sm text-muted-foreground'
                  }
                  title={usageLabel}
                >
                  {run.usage?.status === 'known'
                    ? formatAutomationTokens(run.usage.totalTokens)
                    : 'n/a'}
                </div>
                <div className="flex justify-start">
                  <Badge variant={getAutomationRunStatusVariant(run.status)}>
                    {getAutomationRunStatusLabel(run.status)}
                  </Badge>
                </div>
              </>
            )
            return runWorktree ? (
              <button
                key={run.id}
                type="button"
                className={`${rowClassName} w-full cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50`}
                onClick={() => onOpenRunWorkspace(run)}
              >
                {rowContent}
              </button>
            ) : (
              <div key={run.id} className={rowClassName}>
                {rowContent}
              </div>
            )
          })}
          {runs.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">No runs yet.</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
