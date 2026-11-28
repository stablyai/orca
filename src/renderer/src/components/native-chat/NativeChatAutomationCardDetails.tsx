import { useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { openBotAutomation } from '@/components/bots/bot-automation-open'
import { botErrorMessage } from '@/components/bots/bot-presentation'
import { botTargetChatTitle } from '@/components/automations/authoring/automation-bot-runs-in-chat'
import {
  automationAgentLabel,
  automationResultsPlace,
  automationWhenLines
} from '@/components/automations/details/automation-bot-facts'
import { useAutomationDetails } from '@/components/automations/details/use-automation-details'
import type { AutomationRunsSlice } from '@/components/automations/details/automation-details-model'
import type { AutomationDetailsController } from '@/components/automations/details/automation-details-controller'
import { automationOwnerForEnvironment } from '@/components/automations/hosts/automation-host-owner'
import {
  runAutomationNowForOwner,
  updateAutomationForOwner
} from '@/components/automations/hosts/automation-scoped-list-client'
import { AutomationRecentRunList } from '@/components/automations/runs/AutomationRecentRunList'
import { useAppStore } from '@/store'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { useNow } from '@/lib/window-activity/use-now'
import { useNativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'
import { automationOpenFromCard } from './native-chat-automation-open'

export const AUTOMATION_CARD_RECENT_RUNS = 3

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
  automation,
  runs
}: {
  automation: Pick<Automation, 'id'> & { bot?: { botId: string } }
  runs: AutomationRunsSlice
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(60_000)
  const owner = useNativeChatVisualOwner()
  if (runs.status === 'loading') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('auto.components.automations.AutomationRunsDashboard.loading', 'Loading runs…')}
      </p>
    )
  }
  if (runs.error && runs.value.length === 0) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {runs.error.message}
      </p>
    )
  }
  if (runs.value.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('components.native-chat.automationSaved.noRuns', 'No runs yet')}
      </p>
    )
  }
  return (
    <AutomationRecentRunList
      ariaLabel={t('components.native-chat.automationSaved.recentRuns', 'Recent runs')}
      runs={runs.value}
      now={now}
      onPress={(run) => openBotAutomation(automationOpenFromCard(owner, automation, run.id))}
    />
  )
}

function ReadyDetails({
  automation,
  controller,
  mutating,
  onEditInChat
}: {
  automation: Automation
  controller: AutomationDetailsController
  mutating: boolean
  onEditInChat: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const [running, setRunning] = useState(false)
  const setEnabled = (enabled: boolean): void => {
    void controller
      .mutate(
        (owner) => updateAutomationForOwner(owner, automation.id, { enabled }),
        (next) => next
      )
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  const runNow = (): void => {
    setRunning(true)
    void controller
      .act((owner) => runAutomationNowForOwner(owner, automation.id))
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
      {/* Runs sit beside the facts, and drop below them once the card is too narrow for two columns. */}
      <div className="grid gap-3 @md:grid-cols-2">
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
          <NativeChatCardFact label={t('components.native-chat.automationSaved.when', 'When')}>
            {automationWhenLines(automation).map((line) => (
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
            {automationResultsPlace(automation.bot?.resultsTo)}
          </NativeChatCardFact>
          <NativeChatCardFact label={t('components.native-chat.automationSaved.agent', 'Agent')}>
            {automationAgentLabel(automation)}
          </NativeChatCardFact>
        </dl>
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
          disabled={mutating}
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
  automation,
  environmentId,
  onEditInChat
}: {
  automation: Pick<Automation, 'id'> & { bot?: { botId: string } }
  /** The chat's host; null for this computer. */
  environmentId: string | null
  /** Null outside a chat, where there is no chat box to draft into. */
  onEditInChat: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const visualOwner = useNativeChatVisualOwner()
  // Captured once per host: a re-pair to another machine retires what was read.
  const [owner] = useState(
    () =>
      visualOwner?.automationOwner ??
      automationOwnerForEnvironment(environmentId, useAppStore.getState())
  )
  const { controller, snapshot } = useAutomationDetails({
    owner,
    automationId: automation.id,
    recentLimit: AUTOMATION_CARD_RECENT_RUNS
  })
  const { definition, runs } = snapshot
  return (
    <div className="@container mt-3 border-t border-border pt-3">
      {snapshot.continuity === 'retired' || snapshot.continuity === 'unpaired' ? (
        <p className="text-sm text-muted-foreground">
          {t(
            'bots.automationPanel.refreshBeforeOpen',
            'This computer changed. Refresh this automation before opening it.'
          )}
        </p>
      ) : definition.status === 'loading' ? (
        <Loader2
          className="size-4 animate-spin text-muted-foreground"
          aria-label={t('components.native-chat.automationSaved.loading', 'Loading')}
        />
      ) : definition.status === 'deleted' ? (
        <p className="text-sm text-muted-foreground">
          {t('components.native-chat.automationSaved.deleted', 'This automation was deleted')}
        </p>
      ) : !definition.value ? (
        <p className="text-sm text-muted-foreground">
          {t('components.native-chat.automationSaved.loadFailed', 'Couldn’t read this automation')}
        </p>
      ) : (
        <ReadyDetails
          automation={definition.value}
          controller={controller}
          mutating={snapshot.mutating}
          onEditInChat={
            onEditInChat &&
            snapshot.continuity === 'same' &&
            definition.value.bot?.botId === automation.bot?.botId
              ? () => {
                  if (
                    controller.recheckOwner() === 'same' &&
                    controller.getSnapshot().definition.value?.bot?.botId === automation.bot?.botId
                  ) {
                    onEditInChat?.()
                  }
                }
              : null
          }
        />
      )}
      {snapshot.continuity === 'same' || snapshot.continuity === 'checking' ? (
        <div className="mt-3">
          <RecentRuns automation={definition.value ?? automation} runs={runs} />
          {runs.error ? (
            <Button variant="link" size="inlineText" onClick={() => void controller.refreshRuns()}>
              {t('bots.automationPanel.retry', 'Retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {definition.error ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {t('bots.automationPanel.settingsStale', "Couldn't read the latest settings.")}{' '}
          <Button variant="link" size="inlineText" onClick={() => controller.reload()}>
            {t('bots.automationPanel.retry', 'Retry')}
          </Button>
        </p>
      ) : null}
      {definition.status === 'deleted' ? null : (
        <Button
          type="button"
          variant="link"
          size="inlineText"
          className="mt-3"
          onClick={() =>
            openBotAutomation(automationOpenFromCard(visualOwner, automation, null, 'page'))
          }
        >
          {t('components.native-chat.automationSaved.openFullPage', 'Open page')}
        </Button>
      )}
    </div>
  )
}
