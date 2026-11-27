// The ::orca-webhook{hook="…"} card: a hook's URL and key controls, read from the bot's execution host.
import React, { useState } from 'react'
import { Webhook } from 'lucide-react'
import { ConnectorStatus } from '@/components/bots/BotConnectorRow'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { useWebhookActions } from '@/components/bots/webhooks/use-webhook-actions'
import { useWebhookSummary, WEBHOOK_AGO_TICK_MS } from '@/components/bots/webhooks/use-webhook-data'
import { useNow } from '@/lib/window-activity/use-now'
import { useWebhookKeyScope } from '@/components/bots/webhooks/use-webhook-key'
import {
  webhookErrorMessage,
  webhookFallbackText,
  webhookHostState,
  webhookStatus,
  webhookUnknownBotName
} from '@/components/bots/webhooks/webhook-copy'
import type { WebhookErrorCode } from '@/components/bots/webhooks/webhook-host-client'
import { WebhookKeyFields } from '@/components/bots/webhooks/webhook-key-fields'
import { WebhookSecretDialog } from '@/components/bots/webhooks/WebhookSecretDialog'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import type { Bot } from '../../../../shared/bot-types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WebhookSummary } from '../../../../shared/rpc-contract/webhooks-params'
import { NATIVE_CHAT_SECRET_PROPS } from '../../../../shared/native-chat/input/quotes/native-chat-quote-selection'
import type { NativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'
import type { BotCardCopyValues } from '../../../../shared/native-chat/bot-cards/bot-card-copy'
import {
  WEBHOOK_CARD_COPY as COPY,
  webhookCardBodyView,
  webhookCardShows,
  type WebhookCardSay
} from '../../../../shared/bots/webhook-card-view'

const PIECES: Record<keyof typeof COPY, (t: Translate, values?: BotCardCopyValues) => string> = {
  title: (t) => t('bots.webhooks.card.title', COPY.title),
  starts: (t, values) => t('bots.webhooks.card.starts', COPY.starts, values),
  sampleNote: (t) => t('bots.webhooks.sample.note', COPY.sampleNote),
  sendSample: (t) => t('bots.webhooks.sample.send', COPY.sendSample),
  secretAdd: (t) => t('bots.webhooks.secret.add', COPY.secretAdd),
  secretChange: (t, values) => t('bots.webhooks.secret.change', COPY.secretChange, values)
}
function sayWith(t: Translate): WebhookCardSay {
  return (id, values) => PIECES[id](t, values)
}

function FaintLine({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="my-2 text-xs text-chat-foreground-faint">{children}</p>
}

/** Renders only in the hook's own bot's chats; anywhere else it says where the URL is instead. */
export function NativeChatWebhookCard({
  owner,
  hookId
}: {
  owner: NativeChatVisualOwner
  hookId: string
}): React.JSX.Element {
  const say = sayWith(useTranslate())
  const chatBot = useBotForWorkspace(owner.worktreeId)
  const bots = useBots()
  const read = useWebhookSummary(owner.target, hookId)
  const shows = webhookCardShows(
    read.status,
    chatBot?.id ?? null,
    read.status === 'ready' ? read.value.botId : null
  )
  if (read.status === 'loading') {
    return <WebhookCardFrame title={say('title')} />
  }
  if (read.status === 'failed') {
    return (
      <FaintLine>
        {webhookErrorMessage(read.error, chatBot?.name ?? webhookUnknownBotName(), owner.target)}
      </FaintLine>
    )
  }
  const summary = read.value
  const hookBot = bots.find((bot) => bot.id === summary.botId)
  if (shows !== 'card' || !chatBot) {
    return (
      <p className="my-2">
        {webhookFallbackText(
          hookBot ? { automationName: summary.automationName, botName: hookBot.name } : null
        )}
      </p>
    )
  }
  return (
    <WebhookCardBody
      target={owner.target}
      summary={summary}
      refreshError={read.refreshError}
      bot={chatBot}
    />
  )
}

function WebhookCardFrame({
  title,
  status,
  children
}: {
  title: string
  status?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  // The code block's own shell: its border, surface and header row.
  return (
    <div
      {...NATIVE_CHAT_SECRET_PROPS}
      className="my-3 min-w-0 max-w-full overflow-hidden rounded-lg border border-chat-code-border bg-chat-code-surface select-none"
    >
      <div className="flex h-7.5 items-center justify-between gap-3 px-3">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-chat-foreground-faint">
          <Webhook className="size-3.5 shrink-0" />
          <span className="truncate">{title}</span>
        </span>
        {status}
      </div>
      {children ? (
        <div className="border-t border-chat-code-border px-3 pt-0.5 pb-3">{children}</div>
      ) : null}
    </div>
  )
}

function WebhookCardBody({
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
  const say = sayWith(useTranslate())
  const [secretOpen, setSecretOpen] = useState(false)
  const keyScope = useWebhookKeyScope(target, summary)
  const actions = useWebhookActions(target, summary, bot.name)
  const now = useNow(WEBHOOK_AGO_TICK_MS)
  const view = webhookCardBodyView(
    summary,
    { refreshFailed: refreshError !== null, busy: actions.busy },
    say
  )
  const status = webhookStatus(summary, now)
  const hostLine = webhookHostState(summary, refreshError, bot.name, target).line
  return (
    <WebhookCardFrame
      title={view.title}
      status={<ConnectorStatus label={status.label} tone={status.tone} checking={false} />}
    >
      {hostLine ? <p className="pt-2 text-xs text-muted-foreground">{hostLine}</p> : null}
      <WebhookKeyFields
        key={keyScope}
        target={target}
        summary={summary}
        botName={bot.name}
        canReveal
        headerKey
        disabled={!view.hostReady}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
          {view.sampleNote}
        </span>
        <span className="-mr-1.5 flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="xs"
            disabled={!view.secret.enabled}
            onClick={() => setSecretOpen(true)}
          >
            {view.secret.label}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!view.sample.enabled}
            onClick={actions.sendSample}
          >
            {view.sample.label}
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
    </WebhookCardFrame>
  )
}
