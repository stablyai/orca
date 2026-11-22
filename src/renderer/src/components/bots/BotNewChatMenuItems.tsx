import React from 'react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { newBotHomeChat, startBotSession } from '@/lib/bot-catalog'
import type { Bot, BotAgent } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { chatUnavailableLabel } from '../agent/launch-menu/agent-menu-row-presentation'
import type { NewTabAgentMenuModel } from '../agent/launch-menu/new-tab-agent-menu-model'
import { BotAgentAvatar } from './BotAgentAvatar'
import { useConfirmNewHomeChat } from './bot-home-chat-confirm'
import { botAgentLabel, botErrorMessage } from './bot-presentation'
import { botNewChatAgents } from '../../../../shared/bots/bot-agent-choices'

/** The + menu's bot items in a bot's home: a new Home Chat, then a side chat with the bot on each
 *  agent it can be. The menu's search field keeps focus on open, as in every other workspace. */
export function BotNewChatMenuItems({
  bot,
  model
}: {
  bot: Bot
  model: NewTabAgentMenuModel
}): React.JSX.Element {
  const t = useTranslate()
  // Opens the tab here as well as on the host, refreshing the tab list if it has not arrived yet.
  const opened = (session: Promise<string>): void => {
    void session
      .then((sessionId) =>
        activateAiVaultStructuredSession({
          structuredSession: { workspaceId: folderWorkspaceKey(bot.folderWorkspaceId), sessionId }
        })
      )
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  const start = (agent: BotAgent): void => opened(startBotSession(bot, { agent }))
  const confirmNewHomeChat = useConfirmNewHomeChat()
  const newHomeChat = async (): Promise<void> => {
    if (await confirmNewHomeChat(bot)) {
      opened(newBotHomeChat(bot))
    }
  }

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
            onSelect={() => start(agent)}
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
