// The Composio row in a bot's Tools: the key step first, then the key's line above the app catalog.
// Underneath it is one of the bot's own tools, the session's MCP server.
import React, { useState } from 'react'
import { BotToolLogo } from '../apps/BotToolAppRow'
import { BotConnectorRowFrame, ConnectorStatus } from '@/components/bots/BotConnectorRow'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { ComposioCatalog } from './ComposioCatalog'
import { ComposioKeyControl } from './ComposioKeyControl'
import { COMPOSIO_PAGES } from '../../../../../shared/composio/composio-apps'
import { Button } from '@/components/ui/button'
import {
  checkComposioLimit,
  openComposioPage,
  takeComposioBrowseRequest,
  useComposioBot
} from './composio-client'

const NAME = (): string => translate('bots.composio.toolName', 'Composio apps')

export function ComposioToolRow({ bot }: { bot: Bot }): React.JSX.Element | null {
  const t = useTranslate()
  const view = useComposioBot(bot)
  const [browse] = useState(() => takeComposioBrowseRequest(bot.id))
  const [checking, setChecking] = useState(false)
  if (!view.status) {
    return null
  }
  const { key, limit } = view.status
  const connected = new Set(
    (view.connections?.connections ?? [])
      .filter((entry) => entry.status === 'active')
      .map((entry) => entry.app)
  ).size
  const custody = t('bots.composio.custody', 'Your app sign-ins are held by Composio.')
  const ready = key === 'ok'
  return (
    <BotConnectorRowFrame
      icon={null}
      logo={<BotToolLogo name="composio" />}
      name={NAME()}
      description={
        key === 'none'
          ? t(
              'bots.composio.toolPitch',
              'Use Outlook, Notion, HubSpot and more through your Composio account.'
            )
          : connected > 0
            ? t('bots.composio.toolConnected', '{{count}} connected · {{custody}}', {
                count: connected,
                custody
              })
            : custody
      }
      status={null}
      notice={
        key === 'rejected' || key === 'unreadable' ? (
          <ConnectorStatus
            label={t('bots.composio.keyRejected', 'Key not accepted')}
            tone="attention"
            checking={false}
          />
        ) : limit ? (
          <ConnectorStatus
            label={
              limit.retryAt === null
                ? t('bots.composio.planLimit', 'Composio’s plan limit reached')
                : t('bots.composio.rateLimit', 'Composio is limiting calls for now')
            }
            tone="attention"
            checking={false}
          />
        ) : null
      }
      fix={
        limit
          ? {
              label: t('bots.composio.checkLimit', 'Check again'),
              disabled: checking,
              onClick: () => {
                setChecking(true)
                void checkComposioLimit(bot).finally(() => setChecking(false))
              }
            }
          : null
      }
      trailing={null}
      // Without a working key the key step is what's next, so it's open rather than below a fold.
      defaultOpen={browse || !ready}
      widePanel
    >
      <div className="flex flex-col gap-2 pt-3">
        <ComposioKeyControl hostId={bot.hostId} />
        {limit?.retryAt === null ? (
          <p className="text-xs text-muted-foreground">
            {t('bots.composio.planLimitDetail', 'Composio stops calls until a new month or plan.')}{' '}
            <Button variant="link" size="xs" onClick={() => openComposioPage(COMPOSIO_PAGES.usage)}>
              {t('bots.composio.openUsage', 'Open usage')}
            </Button>
          </p>
        ) : null}
        {ready ? (
          <ComposioCatalog bot={bot} botName={bot.name} view={view} focusSearch={browse} />
        ) : key === 'none' ? null : (
          <p className="text-xs text-muted-foreground">
            {t(
              'bots.composio.keyRejectedRow',
              'All of {{bot}}’s Composio apps are paused until the key is replaced. Your connections are kept at Composio.',
              { bot: bot.name }
            )}
          </p>
        )}
      </div>
    </BotConnectorRowFrame>
  )
}
