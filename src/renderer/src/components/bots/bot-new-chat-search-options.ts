import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { BotNewChatAgent } from '../../../../shared/bots/bot-agent-choices'
import { chatUnavailableLabel } from '../agent/launch-menu/agent-menu-row-presentation'
import {
  BOT_CHAT_OPTION_ID_PREFIX,
  buildTabAgentLaunchOptions,
  type TabAgentLaunchOption
} from '../tab-bar/create-entry/tab-agent-launch-options'
import { botAgentLabel } from './bot-presentation'

function searchAliases(label: string): string[] {
  const normalized = label.trim().toLowerCase()
  return [normalized, normalized.replace(/[\s_-]+/g, '')]
}

/** A bot home's chats as + menu search results, so typing an agent's name finds the side chat on it
 *  as typing it finds the agent in any other workspace. The Home Chat matches on its own name only. */
export function buildBotNewChatSearchOptions(
  bot: Bot,
  agents: readonly BotNewChatAgent[],
  commandOverrides: Partial<Record<TuiAgent, string>> = {},
  t: Translate = translate
): TabAgentLaunchOption[] {
  const homeLabel = t('bots.newHomeChat.action', 'New Home Chat')
  const home: TabAgentLaunchOption = {
    agent: bot.agent,
    id: `${BOT_CHAT_OPTION_ID_PREFIX}home`,
    label: homeLabel,
    aliases: searchAliases(homeLabel),
    botChat: { bot, agent: bot.agent, home: true }
  }
  const sideChats = agents.map(({ agent, unavailable }): TabAgentLaunchOption => {
    const label = t('bots.newAgentChat', 'New {{agent}} Chat', { agent: botAgentLabel(agent) })
    // The agent's own names and command, as in other workspaces, plus the row's label.
    const agentAliases = buildTabAgentLaunchOptions([agent], commandOverrides)[0]?.aliases ?? []
    return {
      agent,
      id: `${BOT_CHAT_OPTION_ID_PREFIX}${agent}`,
      label,
      aliases: [...new Set([...agentAliases, ...searchAliases(label)])],
      ...(unavailable ? { disabled: true, reason: chatUnavailableLabel(unavailable, t) } : {}),
      botChat: { bot, agent, home: false }
    }
  })
  return [home, ...sideChats]
}
