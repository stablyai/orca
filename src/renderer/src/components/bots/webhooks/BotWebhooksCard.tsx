import React from 'react'
import { botTarget } from '@/lib/bot-hosts'
import { Plus, Webhook } from 'lucide-react'
import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { useNow } from '@/lib/window-activity/use-now'
import type { Bot } from '../../../../../shared/bot-types'
import type { WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import { BotConnectorRowFrame } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { BotHowToAsk, HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'
import { BotConnectorSection } from '../bot-connector-people'
import { askBotInChat } from './ask-bot-in-chat'
import { useBotWebhooks, WEBHOOK_AGO_TICK_MS } from './use-webhook-data'
import { webhookSetUpDraft } from './use-webhooks-connector'
import { WebhookHookRow } from './WebhookHookRow'
import { signedOutConnectorFace } from '../orca-cloud-sign-in'
import { useOrcaCloudSignedOut } from '../orca-cloud-signed-out'

function rowFace(
  hooks: readonly WebhookSummary[],
  now: number
): { description: string; status: { label: string; tone: IntegrationCardStatusTone } } {
  const lastAt = Math.max(0, ...hooks.map((hook) => hook.lastCall?.at ?? 0))
  const count = translate('bots.webhooks.hookCount', '{{count}} hooks', {
    count: hooks.length,
    defaultValue_one: '{{count}} hook'
  })
  const description =
    lastAt > 0
      ? `${count} · ${translate('bots.webhooks.lastCallLower', 'last call {{ago}}', { ago: formatUiRelativeTime(lastAt - now) })}`
      : `${count} · ${translate('bots.webhooks.noCallsLower', 'no calls yet')}`
  if (hooks.every((hook) => hook.state === 'paused')) {
    return {
      description,
      status: { label: translate('bots.webhooks.status.paused', 'Paused'), tone: 'neutral' }
    }
  }
  return {
    description,
    status:
      lastAt > 0
        ? { label: translate('bots.webhooks.status.receiving', 'Receiving'), tone: 'connected' }
        : { label: translate('bots.webhooks.status.noCalls', 'No calls yet'), tone: 'neutral' }
  }
}

/** Settings › Bots › Connectors › Webhooks: the bot's hooks. Shown once it has one; the first hook is the connector. */
export function BotWebhooksCard({
  bot,
  title
}: {
  bot: Bot
  /** The row's title from the bot's connector list; see botConnectorTitles. */
  title?: BotConnectorTitle
}): React.JSX.Element | null {
  const t = useTranslate()
  const read = useBotWebhooks(botTarget(bot), bot.id)
  const now = useNow(WEBHOOK_AGO_TICK_MS)
  const signedOut = useOrcaCloudSignedOut(bot.hostId)
  // Without webhooks on the cloud or this Orca, or with none made yet, there is no row.
  if (read.status !== 'ready' || read.value.length === 0) {
    return null
  }
  const hooks = read.value
  const face = signedOut
    ? {
        ...signedOutConnectorFace(),
        description: t('bots.webhooks.pausedSignedOut', '{{hooks}} · paused while signed out', {
          hooks: hooks.map((hook) => hook.automationName).join(', ')
        })
      }
    : rowFace(hooks, now)
  return (
    <BotConnectorRowFrame
      icon={<Webhook className="size-4" />}
      name={title ?? t('bots.webhooks.name', 'Webhooks')}
      description={face.description}
      status={face.status}
      // Hooks are paused and deleted one by one inside, so the menu stays empty.
      actions={{}}
    >
      <BotConnectorSection title={t('bots.webhooks.howToCall', 'How to call')}>
        <p className="mb-4 text-xs leading-5 text-muted-foreground">
          <BotHowToAsk
            text={t(
              'bots.webhooks.howToCallText',
              'Any tool or script can POST to a hook’s URL. Each hook starts one automation, and its results go wherever that automation sends them. To add one, tell {{bot}} <code>Set up a webhook that…</code>',
              { bot: bot.name, ...HOW_TO_ASK_ESCAPED }
            )}
          />
        </p>
      </BotConnectorSection>
      <BotConnectorSection
        title={t('bots.webhooks.hooks', 'Hooks')}
        count={hooks.length}
        action={
          <Button variant="ghost" size="xs" onClick={() => askBotInChat(bot, webhookSetUpDraft())}>
            <Plus />
            {t('bots.webhooks.addInChat', 'Add in chat')}
          </Button>
        }
      >
        {hooks.map((hook) => (
          <WebhookHookRow
            key={hook.hookId}
            target={botTarget(bot)}
            summary={hook}
            refreshError={read.refreshError}
            bot={bot}
            defaultOpen={hooks.length === 1}
          />
        ))}
      </BotConnectorSection>
    </BotConnectorRowFrame>
  )
}
