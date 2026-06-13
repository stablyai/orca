import React from 'react'
import { Pencil, Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import { formatAutomationSchedule } from '../../../../shared/automation-schedules'
import { formatAutomationPrecheckTimeout } from '../../../../shared/automation-precheck'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'
import {
  formatAutomationCost,
  formatAutomationTokens,
  summarizeAutomationRunUsage
} from './automation-usage-model'
import { translate } from '@/i18n/i18n'

type AutomationDetailProps = {
  automation: Automation | null
  runs: AutomationRun[]
  projectName: string
  workspaceName: string
  projectDefaultBaseRef: string | null
  now: number
  onRunNow: (automation: Automation) => void
  onEdit: (automation: Automation) => void
  onToggle: (automation: Automation) => void
  onDelete: (automation: Automation) => void
}

function DetailMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-medium">{value}</div>
    </div>
  )
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
  now,
  onRunNow,
  onEdit,
  onToggle,
  onDelete
}: AutomationDetailProps): React.JSX.Element {
  if (!automation) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {translate(
          'auto.components.automations.AutomationDetail.221916d93c',
          'Create an automation to start scheduling agent work.'
        )}
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
  const agentLabel =
    getAgentCatalog().find((agent) => agent.id === automation.agentId)?.label ?? automation.agentId
  const runLocationLabel =
    automation.workspaceMode === 'new_per_run'
      ? (automation.baseBranch ?? projectDefaultBaseRef ?? 'Project default')
      : workspaceName

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-start justify-between gap-4 border-b border-border/50 pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{automation.name}</h2>
            <Badge variant={automation.enabled ? 'secondary' : 'outline'}>
              {automation.enabled
                ? translate('auto.components.automations.AutomationDetail.eaa02014f8', 'Enabled')
                : translate('auto.components.automations.AutomationDetail.b09b2384fd', 'Paused')}
            </Badge>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {projectName} / {workspaceName}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => onRunNow(automation)}>
            <Play className="size-4" />
            {translate('auto.components.automations.AutomationDetail.2fb1605beb', 'Run Now')}
          </Button>
          <ToolbarIconButton
            label={translate(
              'auto.components.automations.AutomationDetail.4b1ea02d2e',
              'Edit automation'
            )}
            onClick={() => onEdit(automation)}
          >
            <Pencil className="size-4" />
          </ToolbarIconButton>
          <ToolbarIconButton
            label={
              automation.enabled
                ? translate(
                    'auto.components.automations.AutomationDetail.91a4155e95',
                    'Pause automation'
                  )
                : translate(
                    'auto.components.automations.AutomationDetail.d79452fb30',
                    'Resume automation'
                  )
            }
            onClick={() => onToggle(automation)}
          >
            {automation.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
          </ToolbarIconButton>
          <ToolbarIconButton
            label={translate(
              'auto.components.automations.AutomationDetail.1f6026358e',
              'Delete automation'
            )}
            onClick={() => onDelete(automation)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </ToolbarIconButton>
        </div>
      </div>

      {automation.executionTargetType === 'ssh' ? (
        <div className="rounded-md border border-border/50 bg-muted/50 p-3 text-sm text-muted-foreground shadow-sm">
          {translate(
            'auto.components.automations.AutomationDetail.dbef8dc110',
            'This SSH automation runs only while Orca can reach the SSH host. If reconnect needs interactive credentials or the host is unavailable, the run is recorded as skipped.'
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-5 rounded-md border border-border/50 bg-muted/30 px-4 py-3 shadow-sm">
        <DetailMetric
          label={translate('auto.components.automations.AutomationDetail.18763ded26', 'Schedule')}
          value={formatAutomationSchedule(automation.rrule)}
        />
        <DetailMetric
          label={translate('auto.components.automations.AutomationDetail.578ff46987', 'Next run')}
          value={
            automation.enabled
              ? formatAutomationDateTimeWithRelative(automation.nextRunAt, now)
              : 'Paused'
          }
        />
        <DetailMetric
          label={
            automation.workspaceMode === 'new_per_run'
              ? translate('auto.components.automations.AutomationDetail.2f8baf5360', 'Create from')
              : translate('auto.components.automations.AutomationDetail.5405a09b1f', 'Run location')
          }
          value={runLocationLabel}
        />
        <DetailMetric
          label={translate('auto.components.automations.AutomationDetail.15ea446b93', 'Session')}
          value={automation.reuseSession ? 'Reuse live session' : 'Fresh each run'}
        />
        <DetailMetric
          label={translate('auto.components.automations.AutomationDetail.620b22145e', 'Grace')}
          value={formatGrace(automation.missedRunGraceMinutes)}
        />
        <DetailMetric
          label={translate('auto.components.automations.AutomationDetail.e353ab9516', 'Precheck')}
          value={
            automation.precheck
              ? `Enabled, ${formatAutomationPrecheckTimeout(automation.precheck.timeoutSeconds)}`
              : 'None'
          }
        />
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase text-muted-foreground">
            {translate('auto.components.automations.AutomationDetail.2df8970cd5', 'Agent')}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-sm font-medium">
            <AgentIcon agent={automation.agentId} size={16} />
            <span className="truncate">{agentLabel}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-5 rounded-md border border-border/50 bg-muted/20 px-4 py-3 shadow-sm">
        <DetailMetric
          label={translate('auto.components.automations.AutomationDetail.a7c312430d', 'Last run')}
          value={formatAutomationDateTimeWithRelative(automation.lastRunAt, now)}
        />
        <DetailMetric
          label={translate('auto.components.automations.AutomationDetail.401f40ae79', 'Est. spend')}
          value={formatAutomationCost(usageSummary.estimatedCostUsd)}
        />
        <DetailMetric
          label={translate('auto.components.automations.AutomationDetail.449fc83bf7', 'Tokens')}
          value={formatAutomationTokens(usageSummary.totalTokens)}
        />
        <DetailMetric
          label={translate(
            'auto.components.automations.AutomationDetail.a1d52c2189',
            'Usage coverage'
          )}
          value={usageCoverage}
        />
      </div>

      <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
        <div className="border-b border-border/50 px-3 py-2 text-sm font-medium">
          {translate('auto.components.automations.AutomationDetail.007c8ad874', 'Prompt')}
        </div>
        <div className="px-3 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase text-muted-foreground">
              {translate('auto.components.automations.AutomationDetail.007c8ad874', 'Prompt')}
            </div>
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm text-foreground">
              {automation.prompt}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
