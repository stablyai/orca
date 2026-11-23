import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { botAgentLabel, botErrorMessage } from '@/components/bots/bot-presentation'
import { botResultsPlace } from '../../../../shared/automation-bot-target'
import { botTargetChatTitle } from '@/components/automations/authoring/automation-bot-runs-in-chat'
import { eventTriggerLine } from '@/components/automations/authoring/AutomationBotEventsField'
import { formatUiAutomationScheduleDescriptor } from '@/components/automations/details/automation-schedule-label'
import { getAutomationRunStatusLabel } from '@/components/automations/automation-page-parts'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { botAutomationWhenParts } from '../../../../shared/bots/bot-automation-when'
import type {
  Automation,
  AutomationBotResultsTo
} from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import { openReceiptAutomation, type AutomationReceiptSource } from './automation-receipt-client'
import type { AutomationOwnerPrecondition } from '../../../../shared/automations/ownership/automation-owner-precondition'
import type { AutomationCardDetailsController } from './automation-card-details-controller'
import { receiptInstant } from './automation-receipt-copy'
import { NativeChatCardFact } from './NativeChatCardFact'
import {
  automationWebhookTrigger,
  hasAutomationSchedule
} from '../../../../shared/automation-event-triggers'
import { copyWebhookSecret } from '@/components/bots/webhooks/webhook-secret-copy'

function whenLines(automation: Automation, effectiveZone?: string): string[] {
  const lines = botAutomationWhenParts(automation).map((part) =>
    part.kind === 'schedule'
      ? `${formatUiAutomationScheduleDescriptor(part.schedule)} (${effectiveZone ?? translate('components.native-chat.automationSaved.zoneUnknown', 'time zone not recorded')})`
      : eventTriggerLine(part.trigger)
  )
  if (automation.once?.by !== undefined) {
    lines.push(receiptInstant(automation.once.by))
  }
  return lines
}

function resultsPlace(resultsTo: AutomationBotResultsTo | undefined): string {
  // Why: absent is the project default (results stay in each run); explicit none posts nowhere.
  if (resultsTo === undefined) {
    return translate('components.native-chat.automationSaved.resultsInEachRun', 'In each run')
  }
  if (resultsTo === 'none') {
    return translate('automations.botTarget.resultsToNone', 'Nowhere')
  }
  if (resultsTo === 'chat') {
    return translate('components.native-chat.automationSaved.resultsChat', 'Chat')
  }
  if (resultsTo === 'thread') {
    return translate('automations.botTarget.resultsToThread', "The event's thread")
  }
  return botResultsPlace(resultsTo)
}

function agentLabel(automation: Automation): string {
  return automation.bot
    ? botAgentLabel(automation.agentId)
    : (getAgentCatalog().find((agent) => agent.id === automation.agentId)?.label ??
        automation.agentId)
}

function RecentRuns({
  runs,
  onOpen
}: {
  runs: readonly AutomationRun[] | null
  onOpen: (runId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  if (runs === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          'components.native-chat.automationSaved.historyUnavailable',
          'Run history is unavailable'
        )}
      </p>
    )
  }
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('components.native-chat.automationSaved.noRuns', 'No runs yet')}
      </p>
    )
  }
  return (
    <ul
      aria-label={t('components.native-chat.automationSaved.recentRuns', 'Recent runs')}
      className="-mx-1 flex min-w-0 flex-col divide-y divide-border"
    >
      {runs.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            className="flex w-full min-w-0 items-baseline justify-between gap-3 rounded-md px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpen(run.id)}
          >
            <span className="min-w-0 text-sm text-foreground">
              <span className="block truncate">{run.title}</span>
              <span className="text-xs text-muted-foreground">
                {getAutomationRunStatusLabel(run.status) ?? run.status}
              </span>
              {run.error ? (
                <span className="block text-xs text-muted-foreground">{run.error}</span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {t('components.native-chat.automationSaved.runCreatedAt', 'Created {{time}}', {
                time: receiptInstant(run.createdAt)
              })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function NativeChatAutomationCurrentDetails({
  automation,
  runs,
  source,
  owner,
  controller,
  effectiveZone,
  onEditInChat
}: {
  automation: Automation
  runs: readonly AutomationRun[] | null
  source: AutomationReceiptSource
  owner: AutomationOwnerPrecondition
  controller: AutomationCardDetailsController
  effectiveZone?: string
  onEditInChat: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [copying, setCopying] = useState(false)
  const setEnabled = (enabled: boolean): void => {
    setSaving(true)
    void controller
      .setEnabled(enabled)
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setSaving(false))
  }
  const runNow = (): void => {
    setRunning(true)
    void controller
      .run()
      .then(() => {
        toast.message(
          t('auto.components.automations.AutomationsPage.a1bdb57008', 'Automation run queued.')
        )
      })
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setRunning(false))
  }
  return (
    <>
      <p className="mb-2 text-xs text-muted-foreground">
        {t('components.native-chat.automationSaved.currentSettings', 'Current settings')}
      </p>
      {/* Runs sit beside the facts, and drop below them once the card is too narrow for two columns. */}
      <div className="grid gap-3 @md:grid-cols-2">
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
          <NativeChatCardFact label={t('components.native-chat.automationSaved.when', 'When')}>
            {whenLines(automation, effectiveZone).map((line) => (
              <div key={line}>{line}</div>
            ))}
          </NativeChatCardFact>
          {automation.enabled && hasAutomationSchedule(automation) && automation.nextRunAt > 0 ? (
            <NativeChatCardFact label={t('components.native-chat.automationSaved.next', 'Next')}>
              {receiptInstant(automation.nextRunAt)}
            </NativeChatCardFact>
          ) : null}
          {automation.bot ? (
            <NativeChatCardFact label={t('automations.botTarget.runsIn', 'Runs in')}>
              {automation.bot.runsIn === 'new'
                ? t('components.native-chat.automationSaved.newRun', 'A new run')
                : automation.bot.chat
                  ? botTargetChatTitle(automation.bot.chat)
                  : t('components.native-chat.automationSaved.botChat', 'The bot’s Chat')}
            </NativeChatCardFact>
          ) : null}
          <NativeChatCardFact
            label={t('components.native-chat.automationSaved.results', 'Results')}
          >
            {resultsPlace(automation.bot?.resultsTo)}
          </NativeChatCardFact>
          <NativeChatCardFact label={t('components.native-chat.automationSaved.agent', 'Agent')}>
            {agentLabel(automation)}
          </NativeChatCardFact>
        </dl>
        <RecentRuns
          runs={runs}
          onOpen={(runId) => {
            if (!openReceiptAutomation(source, automation, owner, runId)) {
              toast.message(
                t(
                  'components.native-chat.automationSaved.routeUnavailable',
                  'Open this automation from its host’s Automations page.'
                )
              )
            }
          }}
        />
      </div>
      {automation.prompt ? (
        <p className="mt-3 line-clamp-6 whitespace-pre-wrap break-words rounded-md border border-border px-3 py-2 text-sm text-foreground">
          {automation.prompt}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={running || owner.selector.kind === 'orphan'}
          onClick={runNow}
        >
          {t('components.native-chat.automationSaved.runNow', 'Run now')}
        </Button>
        {onEditInChat ? (
          <Button type="button" variant="outline" size="xs" onClick={onEditInChat}>
            {t('automations.botEvents.editInChat', 'Edit in chat')}
          </Button>
        ) : null}
        {automationWebhookTrigger(automation) ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={copying}
            onClick={() => {
              setCopying(true)
              void controller
                .copyWebhookUrl((url) =>
                  copyWebhookSecret(url, t('bots.webhooks.copiedUrl', 'URL copied'))
                )
                .catch((error: unknown) => toast.error(botErrorMessage(error)))
                .finally(() => setCopying(false))
            }}
          >
            {t('bots.webhooks.copyUrl', 'Copy URL')}
          </Button>
        ) : null}
        {automation.once ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={saving}
            onClick={() => {
              setSaving(true)
              void controller
                .remove()
                .catch((error: unknown) => toast.error(botErrorMessage(error)))
                .finally(() => setSaving(false))
            }}
          >
            {t('components.native-chat.automationSaved.remove', 'Remove')}
          </Button>
        ) : null}
        <Switch
          className="ml-auto"
          checked={automation.enabled}
          disabled={saving}
          onCheckedChange={setEnabled}
          aria-label={
            automation.enabled
              ? t('bots.automations.pause', 'Pause {{name}}', {
                  name: automation.name
                })
              : t('bots.automations.resume', 'Resume {{name}}', {
                  name: automation.name
                })
          }
        />
      </div>
    </>
  )
}
