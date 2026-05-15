import React from 'react'
import { Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'

type ExternalAutomationManagersProps = {
  managers: ExternalAutomationManager[]
  now: number
  runningActionKey: string | null
  onAction: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ) => void
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
  onAction
}: ExternalAutomationManagersProps): React.JSX.Element {
  return (
    <div className="mt-6 rounded-md border border-border/50 bg-muted/20 shadow-sm">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div>
          <div className="text-sm font-medium">External managers</div>
        </div>
        <Badge variant="outline">
          {managers.reduce((sum, manager) => sum + manager.jobs.length, 0)} jobs
        </Badge>
      </div>
      <div className="divide-y divide-border/50">
        {managers.map((manager) => (
          <div key={manager.id} className="px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{manager.label}</div>
                <div className="text-xs text-muted-foreground">
                  {manager.status === 'available'
                    ? manager.canManage
                      ? 'Manageable'
                      : 'Read-only'
                    : 'Unavailable'}
                  {manager.error ? ` - ${manager.error}` : null}
                </div>
              </div>
              <Badge variant={manager.status === 'available' ? 'secondary' : 'outline'}>
                {manager.provider}
              </Badge>
            </div>
            <div className="divide-y divide-border/40">
              {manager.jobs.map((job) => (
                <div
                  key={job.id}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,auto)_auto] items-center gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{job.name}</span>
                      <Badge variant={job.enabled ? 'secondary' : 'outline'}>
                        {job.enabled ? 'Active' : 'Paused'}
                      </Badge>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {job.schedule} · next {formatExternalDate(job.nextRunAt, now)}
                    </div>
                    {job.promptPreview || job.lastError ? (
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {job.lastError ?? job.promptPreview}
                      </div>
                    ) : null}
                  </div>
                  <div className="hidden min-w-0 text-xs text-muted-foreground md:block">
                    Last {formatExternalDate(job.lastRunAt, now)}
                    {job.lastStatus ? ` · ${job.lastStatus}` : null}
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <ExternalActionButton
                      label="Run external automation"
                      disabled={!manager.canManage || runningActionKey !== null}
                      onClick={() => onAction(manager, job, 'run')}
                    >
                      {runningActionKey === actionKey(manager, job, 'run') ? (
                        <RefreshCw className="size-3.5 animate-spin" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                    </ExternalActionButton>
                    <ExternalActionButton
                      label={
                        job.enabled ? 'Pause external automation' : 'Resume external automation'
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
                      label="Delete external automation"
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
                </div>
              ))}
              {manager.jobs.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  No {manager.provider === 'hermes' ? 'Hermes' : 'OpenClaw'} jobs found.
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {managers.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No external automation managers found.
          </div>
        ) : null}
      </div>
    </div>
  )
}
