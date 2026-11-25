import React from 'react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { automationAgentLabel } from './automation-bot-facts'
import { cn } from '@/lib/class-names'
import { formatUiNarrowDuration } from '@/i18n/relative-time-format'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { botAutomationWhen } from '../../bots/bot-automation-when'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from '../automation-page-parts'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import { getAutomationHostDetailDisplay } from '../hosts/automation-host-detail-display'
import type { AutomationTargetAvailability } from '../hosts/automation-target-availability-types'
import { automationRunErrorText } from '../runs/automation-run-error-copy'
import { formatUiAutomationSchedule } from './automation-schedule-label'
import { getAgentLabel } from '../authoring/automation-draft-model'
import { getAutomationSourceDisplay } from './automation-source-display'

export type DetailProperty = {
  key: string
  label: string
  value: React.ReactNode
  title?: string
  mono?: boolean
}

/** A titled card; `actions` sit at the end of its title row. */
export function DetailSection({
  title,
  titleId,
  actions,
  children,
  className
}: {
  title: string
  titleId?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section
      aria-labelledby={titleId}
      className={cn('min-w-0 rounded-lg border border-border/60', className)}
    >
      <div className="flex min-h-9 items-center justify-between gap-2 border-b border-border/60 py-1 pr-2 pl-4 @max-[16rem]:pl-3">
        <h3
          id={titleId}
          className={`min-w-0 truncate text-muted-foreground ${AUTOMATION_EDITOR_SECTION_LABEL_CLASS}`}
        >
          {title}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** Label/value rows; below 16rem of container the label stacks above its value. */
export function DetailPropertyList({
  properties
}: {
  properties: DetailProperty[]
}): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-2.5 px-4 py-3 text-[13px] @max-[16rem]:grid-cols-1 @max-[16rem]:gap-y-0.5 @max-[16rem]:px-3">
      {properties.map((property) => (
        <React.Fragment key={property.key}>
          <dt className="text-muted-foreground @max-[16rem]:mt-2 @max-[16rem]:text-xs @max-[16rem]:first:mt-0">
            {property.label}
          </dt>
          <dd
            className={`min-w-0 break-words ${property.mono ? 'font-mono text-xs leading-5' : ''}`}
            title={property.title}
          >
            {property.value}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

export function DetailPropertySection({
  title,
  properties,
  actions
}: {
  title: string
  properties: DetailProperty[]
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <DetailSection title={title} actions={actions}>
      <DetailPropertyList properties={properties} />
    </DetailSection>
  )
}

export function formatAutomationGrace(minutes: number, t: Translate = translate): string {
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

export function useAutomationDetailProperties({
  automation,
  workspaceName,
  projectDefaultBaseRef,
  hostEntry,
  hostLabelById
}: {
  automation: Automation
  workspaceName: string
  projectDefaultBaseRef: string | null
  hostEntry?: AutomationHostCatalogEntry | null
  hostLabelById?: ReadonlyMap<string, string>
}): { schedule: DetailProperty[]; execution: DetailProperty[] } {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
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
  const schedule: DetailProperty[] = [
    {
      key: 'schedule',
      label: t('auto.components.automations.AutomationDetail.repeats', 'Repeats'),
      value: automation.bot
        ? botAutomationWhen(automation)
        : formatUiAutomationSchedule(automation.rrule, t, intlLocale)
    },
    {
      key: 'grace',
      label: t('auto.components.automations.AutomationDetail.missedRunGrace', 'Missed-run grace'),
      value: formatAutomationGrace(automation.missedRunGraceMinutes, t)
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

  const execution: DetailProperty[] = [
    {
      key: 'agent',
      label: t('auto.components.automations.AutomationDetail.2df8970cd5', 'Agent'),
      value: (
        <span className="flex min-w-0 items-center gap-2">
          <AgentIcon agent={automation.agentId} size={14} />
          <span className="truncate">{automationAgentLabel(automation)}</span>
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
  return { schedule, execution }
}

/** Red says something failed; amber that it won't or can't act; info is news. */
export type AutomationDetailNoticeTone = 'red' | 'amber' | 'info'

export type AutomationDetailNotice = {
  key: string
  tone: AutomationDetailNoticeTone
  /** Notices with one cause show once. */
  cause?: string
  /** Lets disabled controls point at the notice that says why (aria-describedby). */
  id?: string
  /** Ranks after every other notice, whatever its tone: it explains one control, not the automation. */
  minor?: true
  content: React.ReactNode
}

const TONE_ORDER: Record<AutomationDetailNoticeTone, number> = { red: 0, amber: 1, info: 2 }
const MINOR_ORDER = 3

/** Most urgent first, red before amber before info, minor last; a repeated cause keeps its first notice. */
export function orderAutomationDetailNotices(
  notices: readonly AutomationDetailNotice[]
): AutomationDetailNotice[] {
  const seen = new Set<string>()
  return [...notices]
    .map((notice, index) => ({ notice, index }))
    .sort(
      (left, right) =>
        (left.notice.minor ? MINOR_ORDER : TONE_ORDER[left.notice.tone]) -
          (right.notice.minor ? MINOR_ORDER : TONE_ORDER[right.notice.tone]) ||
        left.index - right.index
    )
    .map(({ notice }) => notice)
    .filter((notice) => {
      if (!notice.cause) {
        return true
      }
      if (seen.has(notice.cause)) {
        return false
      }
      seen.add(notice.cause)
      return true
    })
}

export function automationDetailNotices({
  automation,
  latestRun,
  runNowAvailability,
  needsMigration,
  migrationNotice,
  t
}: {
  automation: Automation
  latestRun: AutomationRun | undefined
  runNowAvailability: AutomationTargetAvailability | null
  needsMigration: boolean
  /** The page's Migrate notice; the panel leaves migration to the page. */
  migrationNotice?: React.ReactNode
  t: Translate
}): AutomationDetailNotice[] {
  const notices: AutomationDetailNotice[] = []
  const latestRunError =
    latestRun?.status === 'dispatch_failed'
      ? automationRunErrorText(latestRun, getAgentLabel(automation.agentId))
      : null
  if (latestRunError) {
    notices.push({
      key: 'last-run-failed',
      tone: 'red',
      content: (
        <>
          <span className="font-medium text-destructive">
            {t('auto.components.automations.AutomationDetail.lastRunFailed', 'Last run failed.')}
          </span>{' '}
          {latestRunError}
        </>
      )
    })
  }
  if (needsMigration && migrationNotice) {
    notices.push({ key: 'migrate', tone: 'amber', content: migrationNotice })
  } else if (automation.executionTargetType === 'ssh') {
    notices.push({
      key: 'ssh',
      tone: 'amber',
      content: t(
        'auto.components.automations.AutomationDetail.dbef8dc110',
        'This SSH automation runs only while Orca can reach the SSH host. If reconnect needs interactive credentials or the host is unavailable, the run is recorded as skipped.'
      )
    })
  }
  if (runNowAvailability?.canRunNow === false && !needsMigration) {
    notices.push({ key: 'run-now', tone: 'amber', content: runNowAvailability.message })
  }
  return notices
}

const NOTICE_TONE_CLASS: Record<AutomationDetailNoticeTone, string> = {
  red: 'border-destructive/30 bg-destructive/10 text-foreground',
  amber: 'border-status-warning-border bg-status-warning-background text-foreground',
  info: 'border-border/50 bg-muted/50 text-muted-foreground'
}

/** The ordered notices; with `limit`, the rest fold into "+N more". */
export function AutomationDetailNotices({
  notices,
  limit
}: {
  notices: readonly AutomationDetailNotice[]
  limit?: number
}): React.JSX.Element | null {
  const t = useTranslate()
  const [expanded, setExpanded] = React.useState(false)
  const ordered = orderAutomationDetailNotices(notices)
  if (ordered.length === 0) {
    return null
  }
  const shown = limit === undefined || expanded ? ordered : ordered.slice(0, limit)
  const hidden = ordered.length - shown.length
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {shown.map((notice) => (
        <div
          key={notice.key}
          id={notice.id}
          role={notice.tone === 'red' ? 'alert' : 'status'}
          className={cn(
            'flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-md border px-3 py-2 text-sm [overflow-wrap:anywhere]',
            NOTICE_TONE_CLASS[notice.tone]
          )}
        >
          {notice.content}
        </div>
      ))}
      {notices
        .filter((notice) => notice.id && !shown.some((visible) => visible.id === notice.id))
        .map((notice) => (
          <div key={notice.key} id={notice.id} hidden>
            {notice.content}
          </div>
        ))}
      {hidden > 0 ? (
        <button
          type="button"
          className="min-h-6 self-start rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setExpanded(true)}
        >
          {t('auto.components.automations.AutomationDetail.moreNotices', '+{{count}} more', {
            count: hidden
          })}
        </button>
      ) : null}
    </div>
  )
}
