import React from 'react'
import { useAppStore } from '@/store'
import { BotConnectorsSection } from '../settings/bots/BotConnectorsSection'
import { useBotForWorkspace } from './bot-workspace'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'

/** The bot page's Connectors tab: the same list as Settings › Bots › Connectors. */
export default function BotConnectorsPanel(): React.JSX.Element | null {
  const workspaceId = useAppStore((s) => s.activeWorktreeId)
  const bot = useBotForWorkspace(workspaceId)
  return bot ? <BotConnectorsPanelBody key={botRefKey(bot)} bot={bot} /> : null
}

function BotConnectorsPanelBody({ bot }: { bot: Bot }): React.JSX.Element {
  // Its server is down: the list stays as last read, with its actions off until it's back.
  const offline = useBotHostOffline(bot.hostId)
  return (
    <div className="scrollbar-sleek @container/connectors-panel flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3">
      <fieldset disabled={offline} className="contents">
        <BotConnectorsSection bot={bot} />
      </fieldset>
    </div>
  )
}
