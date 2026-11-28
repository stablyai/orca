import {
  AutomationDetailNotices,
  automationDetailNotices,
  DetailPropertySection,
  useAutomationDetailProperties
} from './automation-detail-sections'
import { botAutomationWhen } from '../../bots/bot-automation-when'
import { AutomationWontFireNote } from './AutomationWontFireNote'
import React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { formatUiAutomationSchedule } from './automation-schedule-label'
import { indexLatestAutomationRuns } from '../../../../../shared/automation-last-run'
import type { AutomationTargetAvailability } from '../hosts/automation-target-availability-types'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import { getAutomationHostDetailDisplay } from '../hosts/automation-host-detail-display'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { AutomationPromptDisclosure } from './AutomationPromptDisclosure'
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

const NO_HISTORY_RECOVERY = (): void => {}

export function AutomationDetail(props: AutomationDetailProps): React.JSX.Element {
  const t = useTranslate()
  if (!props.automation) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t(
          'auto.components.automations.AutomationDetail.221916d93c',
          'Create an automation to start scheduling agent work.'
        )}
      </div>
    )
  }
  return <AutomationDetailBody {...props} automation={props.automation} />
}

function AutomationDetailBody({
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
}: AutomationDetailProps & { automation: Automation }): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const properties = useAutomationDetailProperties({
    automation,
    workspaceName,
    projectDefaultBaseRef,
    hostEntry,
    hostLabelById
  })
  const hostDisplay = getAutomationHostDetailDisplay({
    automation,
    entry: hostEntry,
    hostLabelById
  })
  const needsMigration = Boolean(hostEntry?.servedBy)
  const latestRun = indexLatestAutomationRuns(runs).get(automation.id)
  const scheduleLabel = formatUiAutomationSchedule(automation.rrule, t, intlLocale)
  const statusLabel = !automation.enabled
    ? t('auto.components.automations.enablement.paused', 'Paused')
    : needsMigration
      ? t('auto.components.automations.AutomationDetail.needsMigration', 'Needs migration')
      : t('auto.components.automations.AutomationDetail.active', 'Active')
  const metaParts = [
    { key: 'schedule', value: automation.bot ? botAutomationWhen(automation) : scheduleLabel },
    { key: 'project', value: projectName },
    { key: 'host', value: hostDisplay.label }
  ].filter((part) => Boolean(part.value))

  const notices = automationDetailNotices({
    automation,
    latestRun,
    runNowAvailability,
    needsMigration,
    t,
    migrationNotice: (
      <>
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
      </>
    )
  })

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

      {automation.bot ? <AutomationWontFireNote automation={automation} /> : null}
      <AutomationDetailNotices notices={notices} />

      <AutomationDetailHealth
        automation={automation}
        runs={runs}
        runsUnavailable={Boolean(runsNotice)}
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
                properties={properties.schedule}
              />
              <DetailPropertySection
                title={t('auto.components.automations.AutomationDetail.execution', 'Execution')}
                properties={properties.execution}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
