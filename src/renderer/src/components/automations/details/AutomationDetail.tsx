import React from 'react'
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
import { AutomationDetailHeader } from './AutomationDetailHeader'
import { AutomationDetailHealth } from './AutomationDetailHealth'

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

  const scheduleProperties: DetailProperty[] = [
    {
      key: 'schedule',
      label: t('auto.components.automations.AutomationDetail.repeats', 'Repeats'),
      value: formatUiAutomationSchedule(automation.rrule, t, intlLocale)
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
    <div className="@container mx-auto flex w-full max-w-5xl flex-col gap-5">
      <AutomationDetailHeader
        automation={automation}
        subtitle={`${projectName} / ${workspaceName}`}
        needsMigration={needsMigration}
        runNowAvailability={runNowAvailability}
        onRunNow={onRunNow}
        onEdit={onEdit}
        onToggle={onToggle}
        onDelete={onDelete}
      />

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

      <AutomationDetailHealth automation={automation} runs={runs} latestRun={latestRun} now={now} />

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        <DetailPropertySection
          title={t('auto.components.automations.AutomationDetail.18763ded26', 'Schedule')}
          properties={scheduleProperties}
        />
        <DetailPropertySection
          title={t('auto.components.automations.AutomationDetail.execution', 'Execution')}
          properties={executionProperties}
        />
      </div>

      <AutomationPromptDisclosure
        key={`${automation.id}:${automation.prompt}`}
        prompt={automation.prompt}
      />
    </div>
  )
}
