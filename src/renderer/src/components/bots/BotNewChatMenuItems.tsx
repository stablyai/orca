import React from 'react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { chatUnavailableLabel } from '../agent/launch-menu/agent-menu-row-presentation'
import type { NewTabAgentMenuModel } from '../agent/launch-menu/new-tab-agent-menu-model'
import { BotAgentAvatar } from './BotAgentAvatar'
import { botAgentLabel } from './bot-presentation'
import { useBotNewChatLaunch } from './use-bot-new-chat-launch'
import { botNewChatAgents } from '../../../../shared/bots/bot-agent-choices'

/** The + menu's bot items in a bot's home: a new Home Chat, then a side chat with the bot on each
 *  agent it can be. The menu's search field keeps focus on open, as in every other workspace; while
 *  it holds a query the same chats are search results instead (`buildBotNewChatSearchOptions`). */
export function BotNewChatMenuItems({
  bot,
  model
}: {
  bot: Bot
  model: NewTabAgentMenuModel
}): React.JSX.Element {
  const t = useTranslate()
  const { startSideChat, newHomeChat } = useBotNewChatLaunch(bot)

  const entries = botNewChatAgents(bot, model)
  return (
    <>
      <DropdownMenuItem variant="create" onSelect={() => void newHomeChat()}>
        <BotAgentAvatar bot={bot} agent={bot.agent} />
        <span className="min-w-0 flex-1 truncate">
          {t('bots.newHomeChat.action', 'New Home Chat')}
        </span>
        <span className="font-normal text-muted-foreground">
          {t('bots.newHomeChat.hint', 'starts fresh')}
        </span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>
        {t('bots.sideChatsWith', 'Side chats with {{name}}', { name: bot.name })}
      </DropdownMenuLabel>
      {entries.map(({ agent, unavailable }) => {
        const label = t('bots.newAgentChat', 'New {{agent}} Chat', {
          agent: botAgentLabel(agent)
        })
        // The avatar shows the bot; its name stays in what screen readers and the tooltip say.
        const fullLabel = t('bots.newChatWithAgent', 'New chat with {{name}} · {{agent}}', {
          name: bot.name,
          agent: botAgentLabel(agent)
        })
        return unavailable ? (
          <DropdownMenuItem
            key={agent}
            variant="create"
            disabled
            aria-label={`${fullLabel} · ${chatUnavailableLabel(unavailable)}`}
            title={fullLabel}
          >
            <BotAgentAvatar bot={bot} agent={agent} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="font-normal text-muted-foreground">
              {chatUnavailableLabel(unavailable)}
            </span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            key={agent}
            variant="create"
            onSelect={() => startSideChat(agent)}
            onKeyDown={sendTypingToSearch}
            aria-label={fullLabel}
            title={fullLabel}
          >
            <BotAgentAvatar bot={bot} agent={agent} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </DropdownMenuItem>
        )
      })}
    </>
  )
}

/** Typing still searches: the keystroke goes to the menu's search field, not the menu's typeahead. */
function sendTypingToSearch(event: React.KeyboardEvent<HTMLDivElement>): void {
  const search = event.currentTarget.closest('[role="menu"]')?.querySelector('input')
  if (
    search &&
    event.key.length === 1 &&
    event.key !== ' ' &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    event.stopPropagation()
    search.focus()
  }
}
