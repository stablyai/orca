import React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { formatUiAutomationSchedule } from './automation-schedule-label'
import { formatUiNarrowDuration } from '@/i18n/relative-time-format'
import {
  AUTOMATION_EDITOR_SECTION_LABEL_CLASS,
  AutomationRunErrorNotice
} from '../automation-page-parts'
import { indexLatestAutomationRuns } from '../listing/automation-list-last-run'
import type { AutomationTargetAvailability } from '../hosts/automation-target-availability-types'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import { getAutomationHostDetailDisplay } from '../hosts/automation-host-detail-display'
import { getAutomationSourceDisplay } from './automation-source-display'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { AutomationPromptDisclosure } from './AutomationPromptDisclosure'
import { automationRunErrorText } from '../runs/automation-run-error-copy'
import { AutomationDetailHealth } from './AutomationDetailHealth'
import { AutomationRecentRunsRail } from './AutomationRecentRunsRail'
import { AutomationsPageTitle } from '../AutomationsPageFrame'
import type { AutomationActionNotice } from '../hosts/automation-row-action-dispatch'
import type { AutomationHostRecoveryAction } from '../hosts/automation-host-status-descriptors'

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
  /** Set when the history read failed; `runs` is then unknown, not empty. */
  runsNotice?: AutomationActionNotice | null
  onRecoverHistory?: (action: AutomationHostRecoveryAction) => void
  onOpenRun: (run: AutomationRun) => void
  onShowAllRuns: () => void
  /** Moves a row its host's Orca server now serves onto that server. */
  onMigrate?: (automation: Automation) => void
  isMigrating?: boolean
}

type DetailProperty = {
  key: string
  label: string
  value: React.ReactNode
  title?: string
  mono?: boolean
}

function DetailPropertySection({
  title,
  properties
}: {
  title: string
  properties: DetailProperty[]
}): React.JSX.Element {
  return (
    <section className="min-w-0 rounded-lg border border-border/60">
      <h3
        className={`border-b border-border/60 px-4 py-2.5 text-muted-foreground ${AUTOMATION_EDITOR_SECTION_LABEL_CLASS}`}
      >
        {title}
      </h3>
      <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-2.5 px-4 py-3 text-[13px]">
        {properties.map((property) => (
          <React.Fragment key={property.key}>
            <dt className="text-muted-foreground">{property.label}</dt>
            <dd
              className={`min-w-0 break-words ${property.mono ? 'font-mono text-xs leading-5' : ''}`}
              title={property.title}
            >
              {property.value}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
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

const NO_HISTORY_RECOVERY = (): void => {}

function DetailNotice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
      {children}
    </div>
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
  runsNotice = null,
  onRecoverHistory = NO_HISTORY_RECOVERY,
  onOpenRun,
  onShowAllRuns,
  onMigrate,
  isMigrating
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
  const needsMigration = Boolean(hostEntry?.servedBy)
  const latestRun = indexLatestAutomationRuns(runs).get(automation.id)
  const latestRunError =
    latestRun?.status === 'dispatch_failed' ? automationRunErrorText(latestRun) : null

  const scheduleLabel = formatUiAutomationSchedule(automation.rrule, t, intlLocale)
  const statusLabel = !automation.enabled
    ? t('auto.components.automations.enablement.paused', 'Paused')
    : needsMigration
      ? t('auto.components.automations.AutomationDetail.needsMigration', 'Needs migration')
      : t('auto.components.automations.AutomationDetail.active', 'Active')
  const metaParts = [
    { key: 'schedule', value: scheduleLabel },
    { key: 'project', value: projectName },
    { key: 'host', value: hostDisplay.label }
  ].filter((part) => Boolean(part.value))

  const scheduleProperties: DetailProperty[] = [
    {
      key: 'schedule',
      label: t('auto.components.automations.AutomationDetail.repeats', 'Repeats'),
      value: scheduleLabel
    },
    {
      key: 'grace',
      label: t('auto.components.automations.AutomationDetail.missedRunGrace', 'Missed-run grace'),
      value: formatGrace(automation.missedRunGraceMinutes, t)
    },
    {
      key: 'precheck',
      label: t('auto.components.automations.AutomationDetail.e353ab9516', 'Precheck'),
      value: automation.precheck
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
        : t('auto.components.automations.AutomationDetail.precheckNone', 'None'),
      title: automation.precheck?.command
    }
  ]

  const executionProperties: DetailProperty[] = [
    {
      key: 'agent',
      label: t('auto.components.automations.AutomationDetail.2df8970cd5', 'Agent'),
      value: (
        <span className="flex min-w-0 items-center gap-2">
          <AgentIcon agent={automation.agentId} size={14} />
          <span className="truncate">{agentLabel}</span>
        </span>
      )
    },
    {
      key: 'host',
      label: t('auto.components.automations.AutomationDetail.host', 'Host'),
      value: hostDisplay.label,
      title: hostDisplay.title
    },
    {
      key: 'location',
      label:
        automation.workspaceMode === 'new_per_run'
          ? t('auto.components.automations.AutomationDetail.2f8baf5360', 'Create from')
          : t('auto.components.automations.AutomationDetail.5405a09b1f', 'Run location'),
      value: runLocationLabel,
      mono: automation.workspaceMode === 'new_per_run'
    },
    {
      key: 'session',
      label: t('auto.components.automations.AutomationDetail.15ea446b93', 'Session'),
      value: automation.reuseSession
        ? t('auto.components.automations.AutomationDetail.reuseLiveSession', 'Reuse live session')
        : t('auto.components.automations.AutomationDetail.freshEachRun', 'Fresh each run')
    },
    ...(sourceDisplay
      ? [
          {
            key: 'source',
            label: t('auto.components.automations.AutomationDetail.29baf8f4c2', 'Source'),
            value: sourceDisplay.label,
            title: sourceDisplay.title
          }
        ]
      : []),
    ...(automation.createdBy
      ? [
          {
            key: 'createdBy',
            label: t('auto.components.automations.AutomationDetail.createdBy', 'Created by'),
            value: (
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate">{automation.createdBy.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {automation.createdBy.pluginKey}
                  </span>
                </span>
                {automation.createdBy.endedAt ? (
                  <span className="text-xs text-muted-foreground">
                    {t(
                      'auto.components.automations.AutomationDetail.createdByEnded',
                      'Plugin removed or disabled; it must ask before changing this automation'
                    )}
                  </span>
                ) : null}
              </span>
            ),
            title: t(
              'auto.components.automations.AutomationDetail.createdByPluginTitle',
              'Plugin {{plugin}}',
              { plugin: automation.createdBy.pluginKey }
            )
          }
        ]
      : []),
    ...(automation.extraAgentArgs
      ? [
          {
            key: 'extraArgs',
            label: t('auto.components.automations.extraAgentArgs.detailLabel', 'Extra arguments'),
            value: automation.extraAgentArgs,
            title: automation.extraAgentArgs,
            mono: true
          }
        ]
      : [])
  ]

  return (
    <div className="flex w-full flex-col gap-5 pt-5">
      <header className="min-w-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <AutomationsPageTitle title={automation.name}>{automation.name}</AutomationsPageTitle>
          <Badge variant={automation.enabled ? 'secondary' : 'outline'} className="shrink-0">
            {automation.enabled && !needsMigration ? (
              <span className="size-1.5 rounded-full bg-status-success" aria-hidden="true" />
            ) : null}
            {statusLabel}
          </Badge>
        </div>
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          {metaParts.map((part, index) => (
            <React.Fragment key={part.key}>
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              <span className="min-w-0 truncate">{part.value}</span>
            </React.Fragment>
          ))}
        </p>
      </header>

      {needsMigration ? (
        <DetailNotice>
          <span className="min-w-0">
            {t(
              'auto.components.automations.AutomationDetail.migrateNotice',
              '{{host}} was upgraded to a new remote host. Migrate this automation to keep it running.',
              { host: hostEntry?.label }
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
        </DetailNotice>
      ) : automation.executionTargetType === 'ssh' ? (
        <DetailNotice>
          {t(
            'auto.components.automations.AutomationDetail.dbef8dc110',
            'This SSH automation runs only while Orca can reach the SSH host. If reconnect needs interactive credentials or the host is unavailable, the run is recorded as skipped.'
          )}
        </DetailNotice>
      ) : null}

      {runNowAvailability?.canRunNow === false && !needsMigration ? (
        <DetailNotice>{runNowAvailability.message}</DetailNotice>
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

      <AutomationDetailHealth
        automation={automation}
        runs={runs}
        latestRun={latestRun}
        now={now}
        onOpenRun={onOpenRun}
      />

      {/* Why: the rail comes first so it sits above the settings when the column is narrow. */}
      <div className="@container">
        <div className="grid grid-cols-1 gap-5 @4xl:grid-cols-[minmax(0,1fr)_18.75rem]">
          <AutomationRecentRunsRail
            className="self-start @4xl:col-start-2 @4xl:row-start-1"
            runs={runs}
            notice={runsNotice}
            onRecoverHistory={onRecoverHistory}
            onOpenRun={onOpenRun}
            onShowAllRuns={onShowAllRuns}
          />
          <div className="@container flex min-w-0 flex-col gap-5 @4xl:col-start-1 @4xl:row-start-1">
            <AutomationPromptDisclosure
              key={`${automation.id}:${automation.prompt}`}
              prompt={automation.prompt}
            />
            <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
              <DetailPropertySection
                title={t('auto.components.automations.AutomationDetail.18763ded26', 'Schedule')}
                properties={scheduleProperties}
              />
              <DetailPropertySection
                title={t('auto.components.automations.AutomationDetail.execution', 'Execution')}
                properties={executionProperties}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
