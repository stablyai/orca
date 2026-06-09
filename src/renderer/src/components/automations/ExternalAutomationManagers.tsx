import React from 'react'
import { Pause, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationRun
} from '../../../../shared/automations-types'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'
import {
  ExternalAutomationRunTable,
  type FetchExternalAutomationRuns
} from './ExternalAutomationRunTable'
import { getExternalAutomationScheduleDisplay } from './external-automation-schedule-display'
import { translate } from '@/i18n/i18n'

type ExternalAutomationManagersProps = {
  managers: ExternalAutomationManager[]
  now: number
  runningActionKey: string | null
  onAction: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ) => void
  onFetchRuns?: FetchExternalAutomationRuns
  onOpenRun?: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    run: ExternalAutomationRun
  ) => void
  onEdit?: (manager: ExternalAutomationManager, job: ExternalAutomationJob) => void
}

function formatExternalDate(value: string | null, now: number): string {
  if (!value) {
    return 'Never'
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return value
  }
  return formatAutomationDateTimeWithRelative(parsed, now)
}

function actionKey(
  manager: ExternalAutomationManager,
  job: ExternalAutomationJob,
  action: ExternalAutomationAction
): string {
  return `${manager.id}:${job.id}:${action}`
}

function getProviderLabel(manager: ExternalAutomationManager): string {
  return manager.provider === 'hermes' ? 'Hermes' : 'OpenClaw'
}

function getTargetKindLabel(manager: ExternalAutomationManager): string {
  return manager.target.type === 'ssh' ? 'Remote SSH' : 'Local'
}

function ExternalActionButton({
  label,
  disabled,
  className,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  className?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className={className}
          disabled={disabled}
          onClick={onClick}
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

export function ExternalAutomationManagers({
  managers,
  now,
  runningActionKey,
  onAction,
  onFetchRuns,
  onOpenRun,
  onEdit
}: ExternalAutomationManagersProps): React.JSX.Element {
  const automationCount = managers.reduce((sum, manager) => sum + manager.jobs.length, 0)

  return (
    <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div>
          <div className="text-sm font-medium">{translate("auto.components.automations.ExternalAutomationManagers.c6695e6fbd", "External automations")}</div>
        </div>
        <Badge variant="outline">
          {automationCount} {automationCount === 1 ? translate("auto.components.automations.ExternalAutomationManagers.701515f010", "automation") : translate("auto.components.automations.ExternalAutomationManagers.e2532150ed", "automations")}
        </Badge>
      </div>
      <div className="divide-y divide-border/50">
        {managers.map((manager) => (
          <div key={manager.id} className="px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{manager.targetLabel}</div>
                <div className="text-xs text-muted-foreground">
                  {getProviderLabel(manager)} / {getTargetKindLabel(manager)} ·{' '}
                  {manager.status === 'available'
                    ? manager.canManage
                      ? translate("auto.components.automations.ExternalAutomationManagers.0a2d4359a8", "Manageable")
                      : translate("auto.components.automations.ExternalAutomationManagers.dbdcec22bd", "Read-only")
                    : translate("auto.components.automations.ExternalAutomationManagers.92405f1431", "Unavailable")}
                  {manager.error ? ` - ${manager.error}` : null}
                </div>
              </div>
              <Badge variant={manager.status === 'available' ? 'secondary' : 'outline'}>
                {manager.provider}
              </Badge>
            </div>
            <div className="divide-y divide-border/40">
              {manager.jobs.map((job) => {
                const scheduleDisplay = getExternalAutomationScheduleDisplay(manager, job)
                return (
                  <div
                    key={job.id}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,auto)_auto] items-center gap-3 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{job.name}</span>
                        <Badge variant={job.enabled ? 'secondary' : 'outline'}>
                          {job.enabled ? translate("auto.components.automations.ExternalAutomationManagers.b3feba84c7", "Active") : translate("auto.components.automations.ExternalAutomationManagers.2b0adbce21", "Paused")}
                        </Badge>
                      </div>
                      <div className="mt-1 truncate text-xs font-medium text-foreground/80">
                        {scheduleDisplay.label}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {translate("auto.components.automations.ExternalAutomationManagers.20fd7a3a15", "next")} {formatExternalDate(job.nextRunAt, now)} · {getProviderLabel(manager)}{' '}
                        / {manager.targetLabel}
                      </div>
                      {manager.provider === "hermes" ? (
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {job.runCount} {job.runCount === 1 ? translate("auto.components.automations.ExternalAutomationManagers.8e9165af08", "run") : translate("auto.components.automations.ExternalAutomationManagers.e66091daf4", "runs")} {translate("auto.components.automations.ExternalAutomationManagers.844f1acb72", "found")}</div>
                      ) : null}
                      {job.promptPreview || job.lastError ? (
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {job.lastError ?? job.promptPreview}
                        </div>
                      ) : null}
                    </div>
                    <div className="hidden min-w-0 text-xs text-muted-foreground md:block">
                      {translate("auto.components.automations.ExternalAutomationManagers.5820648765", "Last")}{formatExternalDate(job.lastRunAt, now)}
                      {job.lastStatus ? ` · ${job.lastStatus}` : null}
                    </div>
                    <div className="flex items-center justify-end gap-1">
                      <ExternalActionButton
                        label={translate("auto.components.automations.ExternalAutomationManagers.cc77ba88ff", "Run external automation")}
                        disabled={!manager.canManage || runningActionKey !== null}
                        onClick={() => onAction(manager, job, 'run')}
                      >
                        {runningActionKey === actionKey(manager, job, 'run') ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : (
                          <Play className="size-3.5" />
                        )}
                      </ExternalActionButton>
                      {manager.provider === "hermes" ? (
                        <ExternalActionButton
                          label={translate("auto.components.automations.ExternalAutomationManagers.1df491fd00", "Edit external automation")}
                          disabled={!manager.canManage || runningActionKey !== null}
                          onClick={() => onEdit?.(manager, job)}
                        >
                          <Pencil className="size-3.5" />
                        </ExternalActionButton>
                      ) : null}
                      <ExternalActionButton
                        label={
                          job.enabled ? translate("auto.components.automations.ExternalAutomationManagers.0def1693bb", "Pause external automation") : translate("auto.components.automations.ExternalAutomationManagers.1c3bfd38fe", "Resume external automation")
                        }
                        disabled={!manager.canManage || runningActionKey !== null}
                        onClick={() => onAction(manager, job, job.enabled ? 'pause' : 'resume')}
                      >
                        {runningActionKey ===
                        actionKey(manager, job, job.enabled ? 'pause' : 'resume') ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : job.enabled ? (
                          <Pause className="size-3.5" />
                        ) : (
                          <Play className="size-3.5" />
                        )}
                      </ExternalActionButton>
                      <ExternalActionButton
                        label={translate("auto.components.automations.ExternalAutomationManagers.a42bf2b27e", "Delete external automation")}
                        className="text-destructive hover:text-destructive"
                        disabled={!manager.canManage || runningActionKey !== null}
                        onClick={() => onAction(manager, job, 'delete')}
                      >
                        {runningActionKey === actionKey(manager, job, 'delete') ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </ExternalActionButton>
                    </div>
                    {manager.provider === "hermes" ? (
                      <div className="col-span-3">
                        <ExternalAutomationRunTable
                          manager={manager}
                          job={job}
                          now={now}
                          onFetchRuns={onFetchRuns}
                          onOpenRun={(run) => onOpenRun?.(manager, job, run)}
                        />
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {manager.jobs.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  {translate("auto.components.automations.ExternalAutomationManagers.3d58d5b67d", "No")}{' '}
                  {manager.provider === 'hermes' ? translate("auto.components.automations.ExternalAutomationManagers.766abf833c", "Hermes") : translate("auto.components.automations.ExternalAutomationManagers.5524365227", "OpenClaw")} {translate("auto.components.automations.ExternalAutomationManagers.6da3bfba4b", "automations found.")}</div>
              ) : null}
            </div>
          </div>
        ))}
        {managers.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            {translate("auto.components.automations.ExternalAutomationManagers.e02f970595", "No external automation managers found.")}</div>
        ) : null}
      </div>
    </div>
  )
}
