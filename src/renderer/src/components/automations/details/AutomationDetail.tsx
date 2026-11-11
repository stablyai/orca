import React from 'react'
import { Pencil, Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { formatUiAutomationSchedule } from './automation-schedule-label'
import { formatUiNarrowDuration } from '@/i18n/relative-time-format'
import {
  AutomationRunErrorNotice,
  formatAutomationDateTimeWithRelative
} from '../automation-page-parts'
import { indexLatestAutomationRuns } from '../listing/automation-list-last-run'
import { formatAutomationCost, formatAutomationTokens } from '../runs/automation-usage-model'
import { summarizeAutomationRunUsage } from '../../../../../shared/automations/history/automation-usage-summary'
import type { AutomationTargetAvailability } from '../hosts/automation-target-availability-types'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import { getAutomationHostDetailDisplay } from '../hosts/automation-host-detail-display'
import { getAutomationSourceDisplay } from './automation-source-display'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { AutomationPromptDisclosure } from './AutomationPromptDisclosure'
import { automationRunErrorText } from '../runs/automation-run-error-copy'

type AutomationDetailProps = {
  automation: Automation | null
  runs: AutomationRun[]
  projectName: string
  workspaceName: string
  projectDefaultBaseRef: string | null
  /** The catalog entry the selected row was listed from; absent for legacy unscoped rows. */
  hostEntry?: AutomationHostCatalogEntry | null
  hostLabelById?: ReadonlyMap<string, string>
  runNowAvailability: AutomationTargetAvailability | null
  now: number
  onRunNow: (automation: Automation) => void
  onEdit: (automation: Automation) => void
  /** Moves a row its host's Orca server now serves onto that server. */
  onMigrate?: (automation: Automation) => void
  isMigrating?: boolean
  onToggle: (automation: Automation) => void
  onDelete: (automation: Automation) => void
}

function DetailMetric({
  label,
  value,
  title
}: {
  label: string
  value: string
  title?: string
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-medium" title={title}>
        {value}
      </div>
    </div>
  )
}

function formatGrace(minutes: number, t: Translate = translate): string {
  if (minutes <= 0) {
    return t('auto.components.automations.AutomationDetail.noGrace', 'No grace')
  }
  if (minutes < 60) {
    return t('auto.components.automations.AutomationDetail.graceMinutes', '{{count}} minutes', {
      count: minutes,
      defaultValue_one: '{{count}} minute'
    })
  }
  const hours = minutes / 60
  return t('auto.components.automations.AutomationDetail.graceHours', '{{count}} hours', {
    count: hours,
    defaultValue_one: '{{count}} hour'
  })
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
  hostEntry,
  hostLabelById,
  runNowAvailability,
  now,
  onRunNow,
  onEdit,
  onMigrate,
  isMigrating,
  onToggle,
  onDelete
}: AutomationDetailProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  if (!automation) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t(
          'auto.components.automations.AutomationDetail.221916d93c',
          'Create an automation to start scheduling agent work.'
        )}
      </div>
    )
  }
  const usageSummary = summarizeAutomationRunUsage(runs)
  const usageCoverage =
    usageSummary.knownRuns > 0
      ? t(
          'auto.components.automations.AutomationDetail.usageCoverageRuns',
          '{{known}}/{{count}} runs',
          {
            known: usageSummary.knownRuns,
            count: runs.length,
            defaultValue_one: '{{known}}/{{count}} run'
          }
        )
      : usageSummary.unavailableRuns > 0
        ? t('auto.components.automations.AutomationDetail.usageUnavailable', 'Unavailable')
        : t('auto.components.automations.AutomationDetail.noRuns', 'No runs')
  const agentLabel =
    getAgentCatalog().find((agent) => agent.id === automation.agentId)?.label ?? automation.agentId
  const runLocationLabel =
    automation.workspaceMode === 'new_per_run'
      ? (automation.baseBranch ??
        projectDefaultBaseRef ??
        t('auto.components.automations.AutomationDetail.projectDefault', 'Project default'))
      : workspaceName
  const sourceDisplay = getAutomationSourceDisplay(automation.sourceContext, hostLabelById, t)
  const hostDisplay = getAutomationHostDetailDisplay({
    automation,
    entry: hostEntry,
    hostLabelById
  })
  const runNowDisabled = runNowAvailability?.canRunNow === false
  const latestRun = indexLatestAutomationRuns(runs).get(automation.id)
  const latestRunError =
    latestRun?.status === 'dispatch_failed' ? automationRunErrorText(latestRun) : null

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-start justify-between gap-4 border-b border-border/50 pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{automation.name}</h2>
            <Badge variant={automation.enabled ? 'secondary' : 'outline'}>
              {!automation.enabled
                ? t('auto.components.automations.enablement.paused', 'Paused')
                : hostEntry?.servedBy
                  ? t(
                      'auto.components.automations.AutomationDetail.needsMigration',
                      'Needs migration'
                    )
                  : t('auto.components.automations.AutomationDetail.eaa02014f8', 'Enabled')}
            </Badge>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {projectName} / {workspaceName}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onRunNow(automation)}
                  disabled={runNowDisabled}
                >
                  <Play className="size-4" />
                  {t('auto.components.automations.AutomationDetail.2fb1605beb', 'Run Now')}
                </Button>
              </span>
            </TooltipTrigger>
            {runNowDisabled ? (
              <TooltipContent side="bottom" sideOffset={6}>
                {runNowAvailability.message}
              </TooltipContent>
            ) : null}
          </Tooltip>
          <ToolbarIconButton
            label={t('auto.components.automations.AutomationDetail.4b1ea02d2e', 'Edit automation')}
            onClick={() => onEdit(automation)}
          >
            <Pencil className="size-4" />
          </ToolbarIconButton>
          <ToolbarIconButton
            label={
              automation.enabled
                ? t('auto.components.automations.AutomationDetail.91a4155e95', 'Pause automation')
                : t('auto.components.automations.AutomationDetail.d79452fb30', 'Resume automation')
            }
            onClick={() => onToggle(automation)}
          >
            {automation.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
          </ToolbarIconButton>
          <ToolbarIconButton
            label={t(
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

      {hostEntry?.servedBy ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/50 p-3 text-sm text-muted-foreground shadow-sm">
          <span className="min-w-0">
            {t(
              'auto.components.automations.AutomationDetail.migrateNotice',
              '{{host}} was upgraded to a new remote host. Migrate this automation to keep it running.',
              { host: hostEntry.label }
            )}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={isMigrating}
            onClick={() => onMigrate?.(automation)}
          >
            {t('auto.components.automations.AutomationDetail.migrate', 'Migrate')}
          </Button>
        </div>
      ) : automation.executionTargetType === 'ssh' ? (
        <div className="rounded-md border border-border/50 bg-muted/50 p-3 text-sm text-muted-foreground shadow-sm">
          {t(
            'auto.components.automations.AutomationDetail.dbef8dc110',
            'This SSH automation runs only while Orca can reach the SSH host. If reconnect needs interactive credentials or the host is unavailable, the run is recorded as skipped.'
          )}
        </div>
      ) : null}

      {runNowAvailability?.canRunNow === false && !hostEntry?.servedBy ? (
        <div className="rounded-md border border-border/50 bg-muted/40 p-3 text-sm text-muted-foreground shadow-sm">
          {runNowAvailability.message}
        </div>
      ) : null}

      {latestRunError ? (
        <AutomationRunErrorNotice
          label={t(
            'auto.components.automations.AutomationDetail.lastRunFailed',
            'Last run failed.'
          )}
          error={latestRunError}
        />
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-5 rounded-md border border-border/50 bg-muted/30 px-4 py-3 shadow-sm">
        <DetailMetric
          label={t('auto.components.automations.AutomationDetail.18763ded26', 'Schedule')}
          value={formatUiAutomationSchedule(automation.rrule, t, intlLocale)}
        />
        <DetailMetric
          label={t('auto.components.automations.AutomationDetail.578ff46987', 'Next run')}
          value={
            automation.enabled
              ? formatAutomationDateTimeWithRelative(automation.nextRunAt, now, t, intlLocale)
              : t('auto.components.automations.AutomationsPage.paused', 'Paused')
          }
        />
        <DetailMetric
          label={t('auto.components.automations.AutomationDetail.host', 'Host')}
          value={hostDisplay.label}
          title={hostDisplay.title}
        />
        <DetailMetric
          label={
            automation.workspaceMode === 'new_per_run'
              ? t('auto.components.automations.AutomationDetail.2f8baf5360', 'Create from')
              : t('auto.components.automations.AutomationDetail.5405a09b1f', 'Run location')
          }
          value={runLocationLabel}
        />
        <DetailMetric
          label={t('auto.components.automations.AutomationDetail.15ea446b93', 'Session')}
          value={
            automation.reuseSession
              ? t(
                  'auto.components.automations.AutomationDetail.reuseLiveSession',
                  'Reuse live session'
                )
              : t('auto.components.automations.AutomationDetail.freshEachRun', 'Fresh each run')
          }
        />
        {sourceDisplay ? (
          <DetailMetric
            label={t('auto.components.automations.AutomationDetail.29baf8f4c2', 'Source')}
            value={sourceDisplay.label}
            title={sourceDisplay.title}
          />
        ) : null}
        <DetailMetric
          label={t('auto.components.automations.AutomationDetail.620b22145e', 'Grace')}
          value={formatGrace(automation.missedRunGraceMinutes, t)}
        />
        <DetailMetric
          label={t('auto.components.automations.AutomationDetail.e353ab9516', 'Precheck')}
          value={
            automation.precheck
              ? t(
                  'auto.components.automations.AutomationDetail.precheckEnabled',
                  'Enabled, {{timeout}}',
                  {
                    timeout: formatUiNarrowDuration(
                      automation.precheck.timeoutSeconds,
                      'second',
                      intlLocale
                    )
                  }
                )
              : t('auto.components.automations.AutomationDetail.precheckNone', 'None')
          }
        />
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase text-muted-foreground">
            {t('auto.components.automations.AutomationDetail.2df8970cd5', 'Agent')}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-sm font-medium">
            <AgentIcon agent={automation.agentId} size={16} />
            <span className="truncate">{agentLabel}</span>
          </div>
        </div>
        {automation.extraAgentArgs ? (
          <DetailMetric
            label={t('auto.components.automations.extraAgentArgs.detailLabel', 'Extra arguments')}
            value={automation.extraAgentArgs}
            title={automation.extraAgentArgs}
          />
        ) : null}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-5 rounded-md border border-border/50 bg-muted/20 px-4 py-3 shadow-sm">
        <DetailMetric
          label={t('auto.components.automations.AutomationDetail.a7c312430d', 'Last run')}
          value={formatAutomationDateTimeWithRelative(automation.lastRunAt, now, t, intlLocale)}
        />
        <DetailMetric
          label={t('auto.components.automations.AutomationDetail.401f40ae79', 'Est. spend')}
          value={formatAutomationCost(usageSummary.estimatedCostUsd, t)}
        />
        <DetailMetric
          label={t('auto.components.automations.AutomationDetail.449fc83bf7', 'Tokens')}
          value={formatAutomationTokens(usageSummary.totalTokens, intlLocale)}
        />
        <DetailMetric
          label={t('auto.components.automations.AutomationDetail.a1d52c2189', 'Usage coverage')}
          value={usageCoverage}
        />
      </div>

      <AutomationPromptDisclosure
        key={`${automation.id}:${automation.prompt}`}
        prompt={automation.prompt}
      />
    </div>
  )
}
