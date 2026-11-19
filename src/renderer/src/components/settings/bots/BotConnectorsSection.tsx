import React from 'react'
import { Plus } from 'lucide-react'
import { AddConnectorButton } from '@/components/bots/AddConnectorButton'
import { BotAppBrandLogo } from '@/components/bots/apps/BotAppBrandLogo'
import { BotToolAppRow } from '@/components/bots/apps/BotToolAppRow'
import {
  type BotConnectorEntry,
  useBotConnectorEntries
} from '@/components/bots/bot-connector-entries'
import { ACCOUNT_CONNECTORS } from '@/components/bots/bot-connectors'
import {
  BotComposioAppRow,
  BotComposioProblemRow
} from '@/components/bots/composio/BotComposioAppRow'
import { useWebhooksConnector } from '@/components/bots/webhooks/use-webhooks-connector'
import { Button } from '@/components/ui/button'
import { BotGitHubCard } from '@/components/bots/github/BotGitHubCard'
import { BotGoogleCard } from '@/components/bots/google/BotGoogleCard'
import { BotLinearCard } from '@/components/bots/linear/BotLinearCard'
import { BotSlackCard } from '@/components/bots/slack/BotSlackCard'
import { BotWebhooksCard } from '@/components/bots/webhooks/BotWebhooksCard'
import { BotCloudSignInNotice } from '@/components/bots/BotCloudSignInNotice'
import { BotConnectorsHostNotice } from '@/components/bots/BotConnectorsHostNotice'
import { BotConnectorRowKey } from '@/components/bots/bot-connector-row-open'
import { botRefKey } from '@/lib/bot-hosts'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'

/** One connector's row: closed until clicked, unless it needs the owner; then as the owner left it. */
function BotConnectorEntryRow({
  bot,
  entry
}: {
  bot: Bot
  entry: BotConnectorEntry
}): React.JSX.Element {
  // The row keeps its open state for the session, here and on the bot's Connectors tab alike.
  const rowKey = `${botRefKey(bot)}\u0000${entry.key}`
  return (
    <BotConnectorRowKey.Provider value={rowKey}>
      <BotConnectorEntryCard bot={bot} entry={entry} />
    </BotConnectorRowKey.Provider>
  )
}

function BotConnectorEntryCard({
  bot,
  entry
}: {
  bot: Bot
  entry: BotConnectorEntry
}): React.JSX.Element | null {
  const { title, needsOwner: defaultOpen } = entry
  switch (entry.kind) {
    case 'slack':
      return (
        <BotSlackCard bot={bot} teamId={entry.teamId} title={title} defaultOpen={defaultOpen} />
      )
    case 'linear':
      return (
        <BotLinearCard bot={bot} linear={entry.linear} title={title} defaultOpen={defaultOpen} />
      )
    case 'github':
      return (
        <BotGitHubCard
          bot={bot}
          installation={entry.installation}
          title={title}
          defaultOpen={defaultOpen}
        />
      )
    case 'google':
      return <BotGoogleCard bot={bot} title={title} defaultOpen={defaultOpen} />
    case 'webhooks':
      return <BotWebhooksCard bot={bot} title={title} />
    case 'composio':
      return (
        <BotComposioAppRow
          bot={bot}
          connection={entry.connection}
          problem={entry.problem}
          title={title}
          defaultOpen={defaultOpen}
        />
      )
    case 'composio-problem':
      return (
        <BotComposioProblemRow
          bot={bot}
          problem={entry.problem}
          title={title}
          defaultOpen={defaultOpen}
        />
      )
    case 'app':
      return <BotToolAppRow bot={bot} entry={entry} title={title} defaultOpen={defaultOpen} />
  }
}

/** The bot page's Connectors tab when the bot has none: what they're for, and Add a connector. */
/** No connectors yet: their logos, what they're for, and Add a connector. */
export function BotNoConnectors({ bot }: { bot: Bot }): React.JSX.Element {
  return (
    <AddConnectorButton bot={bot} trigger={(open) => <NoConnectors bot={bot} onAdd={open} />} />
  )
}

function NoConnectors({ bot, onAdd }: { bot: Bot; onAdd: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <div className="flex gap-2">
        {ACCOUNT_CONNECTORS.filter((connector) => connector.available).map((connector) => (
          <BotAppBrandLogo key={connector.id} app={connector} />
        ))}
      </div>
      <p className="max-w-64 text-xs leading-5 text-muted-foreground">
        {t(
          'bots.connectors.emptyNote',
          'Let people reach {{name}} in Slack, GitHub and Linear, and let it work in your Google and other apps.',
          { name: bot.name }
        )}
      </p>
      <Button size="sm" onClick={onAdd}>
        <Plus />
        {t('settings.bots.addConnector', 'Add a connector')}
      </Button>
    </div>
  )
}

/**
 * The bot's connectors, one row per workspace, org or app, with Add in the list's header: the
 * bot page's Connectors tab and the Connectors page of its settings.
 */
export function BotConnectorsSection({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const entries = useBotConnectorEntries(bot, 'apps')
  const webhooks = useWebhooksConnector(bot)
  // Keyed by host and bot too, so showing another bot gives each of its rows a fresh mount.
  const rows = entries.map((entry) => (
    <BotConnectorEntryRow key={`${botRefKey(bot)}\u0000${entry.key}`} bot={bot} entry={entry} />
  ))
  // The Webhooks row is always listed but shows only once a hook exists.
  const empty = entries.every((entry) => entry.kind === 'webhooks') && webhooks !== 'added'
  return (
    <AddConnectorButton
      bot={bot}
      trigger={(open) =>
        empty ? (
          <section className="flex flex-col gap-0.5">
            <BotConnectorsHostNotice bot={bot} />
            <NoConnectors bot={bot} onAdd={open} />
          </section>
        ) : (
          <section className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2 pr-1 pb-1 pl-2">
              <h3 className="text-sm font-semibold">
                {t('settings.bots.connectors', 'Connectors')}
              </h3>
              <Button variant="ghost" size="xs" onClick={open}>
                <Plus />
                {t('bots.connectors.add', 'Add')}
              </Button>
            </div>
            <BotCloudSignInNotice bot={bot} webhooks={webhooks === 'added'} />
            <BotConnectorsHostNotice bot={bot} />
            {rows}
          </section>
        )
      }
    />
  )
}
