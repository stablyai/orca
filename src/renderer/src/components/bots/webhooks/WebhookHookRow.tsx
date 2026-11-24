import React, { useId, useState } from 'react'
import { ChevronDown, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { useNow } from '@/lib/window-activity/use-now'
import type { Bot } from '../../../../../shared/bot-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import { ConnectorStatus } from '../BotConnectorRow'
import { askBotInChat } from './ask-bot-in-chat'
import { useWebhookActions } from './use-webhook-actions'
import { WEBHOOK_AGO_TICK_MS } from './use-webhook-data'
import { useWebhookKeyScope } from './use-webhook-key'
import type { WebhookErrorCode } from './webhook-host-client'
import {
  webhookChecks,
  webhookHostState,
  webhookResultsTo,
  webhookStarts,
  webhookStateStatus
} from './webhook-copy'
import { hasWebhookFilters, WebhookOnlyWhen, WebhookQuotes } from './webhook-filter-text'
import { WebhookField, WebhookKeyFields } from './webhook-key-fields'
import { WebhookRecentCalls } from './WebhookRecentCalls'
import { WebhookRotateDialog } from './WebhookRotateDialog'
import { WebhookSecretDialog } from './WebhookSecretDialog'

function hookCaption(summary: WebhookSummary, now: number): string {
  const lastCall = summary.lastCall
    ? translate('bots.webhooks.lastCallLower', 'last call {{ago}}', {
        ago: formatUiRelativeTime(summary.lastCall.at - now)
      })
    : translate('bots.webhooks.noCallsLower', 'no calls yet')
  return `${webhookResultsTo(summary.resultsTo)} · ${lastCall}`
}

/** One hook in the Webhooks row: its URL, checks, filters, recent calls and actions. */
export function WebhookHookRow({
  target,
  summary,
  refreshError,
  bot,
  defaultOpen
}: {
  target: RuntimeClientTarget
  summary: WebhookSummary
  /** Set when the latest read failed and this summary is the last good one. */
  refreshError: WebhookErrorCode | null
  bot: Bot
  defaultOpen: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()
  const now = useNow(WEBHOOK_AGO_TICK_MS)
  const status = webhookStateStatus(summary)
  return (
    <div
      data-state={open ? 'open' : 'closed'}
      className="group/hook border-t border-border first:border-t-0"
    >
      <div className="relative flex items-center gap-3 py-2.5">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
            className="block text-left text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
          >
            {summary.automationName}
          </button>
          <p className="truncate text-xs text-muted-foreground">{hookCaption(summary, now)}</p>
        </div>
        <ConnectorStatus label={status.label} tone={status.tone} checking={false} />
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/hook:rotate-180"
          aria-hidden
        />
      </div>
      {open ? (
        <div id={panelId} className="pb-3">
          <HookDetail target={target} summary={summary} refreshError={refreshError} bot={bot} />
        </div>
      ) : null}
    </div>
  )
}

function HookDetail({
  target,
  summary,
  refreshError,
  bot
}: {
  target: RuntimeClientTarget
  summary: WebhookSummary
  refreshError: WebhookErrorCode | null
  bot: Bot
}): React.JSX.Element {
  const t = useTranslate()
  const [secretOpen, setSecretOpen] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const keyScope = useWebhookKeyScope(target, summary)
  const actions = useWebhookActions(target, summary, bot.name)
  const { ready: hostReady, line: hostLine } = webhookHostState(
    summary,
    refreshError,
    bot.name,
    target
  )
  const editInChat = (): void =>
    askBotInChat(
      bot,
      t('bots.webhooks.editDraft', 'Change when “{{automation}}” runs: ', {
        automation: summary.automationName
      })
    )
  return (
    <>
      {hostLine ? <p className="mb-1 text-xs text-muted-foreground">{hostLine}</p> : null}
      {summary.state === 'orphaned' ? (
        <p className="mb-1 text-xs text-muted-foreground">
          {t(
            'bots.webhooks.orphanedNote',
            '{{bot}}’s Orca no longer lists this automation, so calls aren’t run.',
            { bot: bot.name }
          )}
        </p>
      ) : null}
      <WebhookKeyFields
        key={keyScope}
        target={target}
        summary={summary}
        botName={bot.name}
        canReveal={false}
        headerKey={false}
        disabled={!hostReady}
      />
      <WebhookField
        label={t('bots.webhooks.checksLabel', 'Checks')}
        actions={
          <Button
            variant="ghost"
            size="xs"
            disabled={!hostReady}
            onClick={() => setSecretOpen(true)}
          >
            {summary.adapter
              ? t('bots.webhooks.checks.change', 'Change…')
              : t('bots.webhooks.checks.add', 'Add a signature…')}
          </Button>
        }
      >
        {webhookChecks(summary.adapter)}
      </WebhookField>
      <WebhookField label={t('bots.webhooks.starts', 'Starts')}>
        {webhookStarts(summary)}
      </WebhookField>
      <WebhookField
        label={t('bots.webhooks.onlyWhen', 'Only when')}
        actions={
          <Button variant="ghost" size="xs" onClick={editInChat}>
            {t('bots.webhooks.editInChat', 'Edit in chat')}
          </Button>
        }
      >
        {hasWebhookFilters(summary.filters) ? (
          <WebhookOnlyWhen filters={summary.filters} />
        ) : (
          t('bots.webhooks.everyCall', 'Every call')
        )}
      </WebhookField>
      {summary.filters.pick && summary.filters.pick.length > 0 ? (
        <WebhookField label={t('bots.webhooks.quotes', 'Quotes')}>
          <WebhookQuotes pick={summary.filters.pick} />
        </WebhookField>
      ) : null}
      <WebhookRecentCalls
        target={target}
        hookId={summary.hookId}
        botName={bot.name}
        resultsTo={summary.resultsTo}
      />
      <div className="mt-3 -ml-1.5 flex flex-wrap items-center gap-0.5">
        <Button
          variant="ghost"
          size="xs"
          disabled={!hostReady || actions.busy || summary.state !== 'live'}
          onClick={actions.sendSample}
        >
          {t('bots.webhooks.sample.send', 'Send a sample call')}
        </Button>
        <Button variant="ghost" size="xs" disabled={!hostReady} onClick={() => setRotateOpen(true)}>
          {t('bots.webhooks.rotate.open', 'Rotate key…')}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!hostReady || actions.busy || summary.state === 'orphaned'}
          onClick={() => actions.setPaused(summary.state !== 'paused')}
        >
          {summary.state === 'paused'
            ? t('bots.webhooks.resume', 'Resume')
            : t('bots.webhooks.pause', 'Pause')}
        </Button>
        <span className="-mr-1.5 ml-auto">
          <Button
            variant="ghost"
            size="xs"
            disabled={!hostReady || actions.busy}
            onClick={actions.remove}
          >
            <Trash2 />
            {t('bots.webhooks.delete.open', 'Delete hook…')}
          </Button>
        </span>
      </div>
      <WebhookSecretDialog
        target={target}
        summary={summary}
        botName={bot.name}
        open={secretOpen}
        onOpenChange={setSecretOpen}
      />
      <WebhookRotateDialog
        target={target}
        summary={summary}
        botName={bot.name}
        open={rotateOpen}
        onOpenChange={setRotateOpen}
      />
    </>
  )
}
