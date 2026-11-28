import React from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { openBotAutomation } from './bot-automation-open'
import { useTranslate } from '@/i18n/use-translate'
import { useBotWebhooks } from '@/lib/bot-catalog'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useNow } from '@/lib/window-activity/use-now'
import type { Bot } from '../../../../shared/bot-types'
import type { AutomationOwnerRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import { hasAutomationSchedule } from '../../../../shared/automation-event-triggers'
import {
  getToneForAutomationRunStatus,
  indexLatestAutomationRuns
} from '../../../../shared/automation-last-run'
import { AutomationDetailHeader } from '../automations/details/AutomationDetailHeader'
import {
  AutomationDetailNotices,
  automationDetailNotices
} from '../automations/details/automation-detail-sections'
import { BotAutomationInstructions } from './BotAutomationInstructions'
import { automationWontFire } from '../automations/details/automation-wont-fire'
import type { AutomationDetailsController } from '../automations/details/automation-details-controller'
import type { AutomationDetailsSnapshot } from '../automations/details/automation-details-model'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { upcomingAt } from './bot-upcoming-copy'
import { useOrcaCloudSignedOut } from './orca-cloud-signed-out'
import { useBotHostLabel } from './use-bot-host-label'
import {
  BotAutomationResultsSection,
  BotAutomationWhenSection,
  type SectionProps
} from './BotAutomationSections'
import { BotAutomationSetup } from './BotAutomationSetup'
import { BotAutomationRuns, botAutomationRunAction } from './BotAutomationRuns'
import { useBotAutomationNotices } from './bot-automation-notices'

type BodyProps = {
  bot: Bot
  owner: AutomationOwnerRef
  snapshot: AutomationDetailsSnapshot
  controller: AutomationDetailsController
  titleId: string
  onRetired: () => void
}

function statusLine(
  automation: Automation,
  now: number,
  t: ReturnType<typeof useTranslate>
): string {
  if (!automation.enabled) {
    return t('auto.components.automations.enablement.paused', 'Paused')
  }
  if (!hasAutomationSchedule(automation)) {
    return t('bots.automationPanel.onEvents', 'On · Runs on events')
  }
  return t('bots.automationPanel.onNext', 'On · {{when}}', {
    when: upcomingAt(automation.nextRunAt, now)
  })
}

export function BotAutomationScreenBody(props: BodyProps): React.JSX.Element {
  const t = useTranslate()
  const { bot, owner, snapshot, controller } = props
  const now = useNow(60_000)
  const offline = useBotHostOffline(bot.hostId)
  const hostLabel = useBotHostLabel(bot.hostId)
  const hostName = hostLabel ?? t('bots.host.thisComputer', 'this computer')
  const automation = snapshot.definition.value
  const signedOut = useOrcaCloudSignedOut(bot.hostId)
  const webhooks = useBotWebhooks(bot.hostId)
  const wontFire = automation ? automationWontFire(automation, [bot], webhooks, signedOut) : null
  const unsupported =
    snapshot.definition.error?.kind === 'unsupported' ||
    snapshot.runs.error?.kind === 'unsupported' ||
    snapshot.selected?.status === 'unsupported'
  const latestRun = automation
    ? indexLatestAutomationRuns(snapshot.runs.value).get(automation.id)
    : undefined
  const running = Boolean(
    latestRun && getToneForAutomationRunStatus(latestRun.status) === 'running'
  )
  const runningAction = latestRun ? botAutomationRunAction(bot, latestRun, owner) : null
  const notices = useBotAutomationNotices({
    bot,
    hostName,
    offlineHostName: hostLabel ?? t('bots.automationPanel.thisComputer', 'This computer'),
    snapshot,
    controller,
    offline,
    oldHost: unsupported,
    running,
    runningAction: runningAction
      ? {
          onOpen: runningAction.open,
          label:
            runningAction.kind === 'chat'
              ? t('bots.automationPanel.openChat', 'Open chat')
              : t('bots.automationPanel.openTerminal', 'Open terminal')
        }
      : null,
    wontFire,
    onRetired: props.onRetired
  })
  const history =
    snapshot.continuity === 'retired' || snapshot.continuity === 'unpaired' ? null : (
      <BotAutomationRuns
        bot={bot}
        automation={{ id: controller.automationId }}
        snapshot={snapshot}
        controller={controller}
        now={now}
      />
    )
  if (!automation) {
    return (
      <>
        <AutomationDetailNotices notices={notices.list} limit={1} />
        {snapshot.definition.status === 'loading' ? (
          <p role="status" className="px-2 text-sm text-muted-foreground">
            {t('components.native-chat.automationSaved.loading', 'Loading')}
          </p>
        ) : null}
        {history}
      </>
    )
  }

  const sectionProps: SectionProps = { automation, owner }
  return (
    <>
      <AutomationDetailHeader
        automation={automation}
        titleId={props.titleId}
        subtitle={statusLine(automation, now, t)}
        menuItems={
          <DropdownMenuItem
            onSelect={() =>
              openBotAutomation({
                bot,
                automationId: automation.id,
                hostId: bot.hostId,
                runId: snapshot.expandedRunId ?? snapshot.selected?.runId ?? null,
                owner,
                intent: 'page'
              })
            }
          >
            {t('bots.automationPanel.openOnPage', 'Open in Automations')}{' '}
            <span aria-hidden="true">↗</span>
          </DropdownMenuItem>
        }
      />
      <AutomationDetailNotices
        notices={[
          ...automationDetailNotices({
            automation,
            latestRun,
            runNowAvailability: null,
            needsMigration: false,
            t
          }),
          ...notices.list
        ]}
        limit={1}
      />
      {history}
      <BotAutomationWhenSection {...sectionProps} />
      <BotAutomationResultsSection {...sectionProps} />
      <BotAutomationInstructions automation={automation} />
      <BotAutomationSetup automation={automation} hostName={hostName} botName={bot.name} />
    </>
  )
}
