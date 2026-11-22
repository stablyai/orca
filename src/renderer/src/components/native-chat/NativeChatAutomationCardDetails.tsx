import { useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { openBotAutomation } from '@/components/bots/bot-automation-open'
import { botAgentLabel, botErrorMessage } from '@/components/bots/bot-presentation'
import { botResultsPlace } from '../../../../shared/automation-bot-target'
import { botTargetChatTitle } from '@/components/automations/authoring/automation-bot-runs-in-chat'
import { eventTriggerLine } from '@/components/automations/authoring/AutomationBotEventsField'
import { formatUiAutomationScheduleDescriptor } from '@/components/automations/details/automation-schedule-label'
import {
  runAutomationNowForTarget,
  updateAutomationForTarget,
  type AutomationHostTarget
} from '@/components/automations/hosts/automation-host-client'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { botAutomationWhenParts } from '../../../../shared/bots/bot-automation-when'
import type {
  Automation,
  AutomationBotResultsTo
} from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import { useNow } from '@/lib/window-activity/use-now'
import { useAutomationCardDetails } from './use-automation-card-details'

function whenLines(automation: Automation): string[] {
  return botAutomationWhenParts(automation).map((part) =>
    part.kind === 'schedule'
      ? formatUiAutomationScheduleDescriptor(part.schedule)
      : eventTriggerLine(part.trigger)
  )
}

function resultsPlace(resultsTo: AutomationBotResultsTo | undefined): string {
  if (resultsTo === undefined) {
    return translate('components.native-chat.automationSaved.resultsInEachRun', 'In each run')
  }
  if (resultsTo === 'chat') {
    return translate('components.native-chat.automationSaved.resultsChat', 'Chat')
  }
  if (resultsTo === 'thread') {
    return translate('automations.botTarget.resultsToThread', "The event's thread")
  }
  if (resultsTo === 'none') {
    return translate('automations.botTarget.resultsToNone', 'Nowhere')
  }
  return botResultsPlace(resultsTo)
}

function agentLabel(automation: Automation): string {
  return automation.bot
    ? botAgentLabel(automation.agentId)
    : (getAgentCatalog().find((agent) => agent.id === automation.agentId)?.label ??
        automation.agentId)
}

/** One label/value row of a card's opened details, inside a two-column `dl`. */
export function NativeChatCardFact({
  label,
  children
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <>
      <dt className="pt-0.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </>
  )
}

function RecentRuns({
  automationId,
  runs
}: {
  automationId: string
  runs: readonly AutomationRun[]
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(60_000)
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
            onClick={() => openBotAutomation(automationId, run.id)}
          >
            <span className="min-w-0 truncate text-sm text-foreground">{run.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatUiRelativeTime(run.createdAt - now)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ReadyDetails({
  automation,
  runs,
  target,
  onEditInChat,
  onSaved,
  onRan
}: {
  automation: Automation
  runs: readonly AutomationRun[]
  target: AutomationHostTarget
  onEditInChat: (() => void) | null
  onSaved: (next: Automation) => void
  onRan: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const setEnabled = (enabled: boolean): void => {
    setSaving(true)
    void updateAutomationForTarget(automation, { enabled }, target)
      .then(onSaved)
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setSaving(false))
  }
  const runNow = (): void => {
    setRunning(true)
    void runAutomationNowForTarget(automation, target)
      .then(() => {
        toast.message(
          t('auto.components.automations.AutomationsPage.a1bdb57008', 'Automation run queued.')
        )
        onRan()
      })
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setRunning(false))
  }
  return (
    <>
      {/* Runs sit beside the facts, and drop below them once the card is too narrow for two columns. */}
      <div className="grid gap-3 @md:grid-cols-2">
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
          <NativeChatCardFact label={t('components.native-chat.automationSaved.when', 'When')}>
            {whenLines(automation).map((line) => (
              <div key={line}>{line}</div>
            ))}
          </NativeChatCardFact>
          {automation.bot?.chat ? (
            <NativeChatCardFact label={t('automations.botTarget.runsIn', 'Runs in')}>
              {botTargetChatTitle(automation.bot.chat)}
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
        <RecentRuns automationId={automation.id} runs={runs} />
      </div>
      {automation.prompt ? (
        <p className="mt-3 line-clamp-6 whitespace-pre-wrap break-words rounded-md border border-border px-3 py-2 text-sm text-foreground">
          {automation.prompt}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-1.5">
        <Button type="button" variant="outline" size="xs" disabled={running} onClick={runNow}>
          {t('components.native-chat.automationSaved.runNow', 'Run now')}
        </Button>
        {onEditInChat ? (
          <Button type="button" variant="outline" size="xs" onClick={onEditInChat}>
            {t('automations.botEvents.editInChat', 'Edit in chat')}
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

/** An opened automation card: its live settings, newest runs and actions, read from its host. */
export function NativeChatAutomationCardDetails({
  automationId,
  environmentId,
  onEditInChat
}: {
  automationId: string
  /** The chat's host; null for this computer. */
  environmentId: string | null
  /** Null outside a chat, where there is no chat box to draft into. */
  onEditInChat: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const { details, reload, replace } = useAutomationCardDetails(environmentId, automationId)
  const target: AutomationHostTarget =
    environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
  return (
    <div className="@container mt-3 border-t border-border pt-3">
      {details.status === 'loading' ? (
        <Loader2
          className="size-4 animate-spin text-muted-foreground"
          aria-label={t('components.native-chat.automationSaved.loading', 'Loading')}
        />
      ) : details.status === 'deleted' ? (
        <p className="text-sm text-muted-foreground">
          {t('components.native-chat.automationSaved.deleted', 'This automation was deleted')}
        </p>
      ) : details.status === 'error' ? (
        <p className="text-sm text-muted-foreground">
          {t('components.native-chat.automationSaved.loadFailed', 'Couldn’t read this automation')}
        </p>
      ) : (
        <ReadyDetails
          automation={details.automation}
          runs={details.runs}
          target={target}
          onEditInChat={onEditInChat}
          onSaved={replace}
          onRan={reload}
        />
      )}
      {details.status === 'deleted' ? null : (
        <Button
          type="button"
          variant="link"
          size="inlineText"
          className="mt-3"
          onClick={() => openBotAutomation(automationId, null)}
        >
          {t('components.native-chat.automationSaved.openFullPage', 'Open page')}
        </Button>
      )}
    </div>
  )
}
