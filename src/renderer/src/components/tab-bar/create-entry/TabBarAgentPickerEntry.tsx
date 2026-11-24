import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import {
  useAgentPickerInventoryEntries,
  type AgentPickerInventorySource
} from '../../agent/agent-picker-inventory-source'
import type { NewTabAgentMenuModel } from '../../agent/launch-menu/new-tab-agent-menu-model'
import { buildBotNewChatSearchOptions } from '../../bots/bot-new-chat-search-options'
import { useBotNewChatLaunch } from '../../bots/use-bot-new-chat-launch'
import {
  botNewChatAgents,
  type BotNewChatAgent
} from '../../../../../shared/bots/bot-agent-choices'
import type { ChatUnavailableReason } from '../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import type { Bot, BotAgent } from '../../../../../shared/bot-types'
import {
  buildAgentPickerLaunchOptions,
  type TabAgentLaunchOption
} from './tab-agent-launch-options'
import TabBarCreateEntry from './TabBarCreateEntry'
import type { TabBarCreateEntryProps } from './tab-create-entry-props'

type PickerEntryProps = Omit<TabBarCreateEntryProps, 'agentPickerEntries' | 'agentOptions'> & {
  inventory: AgentPickerInventorySource
  hideAgents?: boolean
}

// Subscribe inside the menu so inventory updates do not re-render the tab bar.
export function TabBarAgentPickerEntry({
  inventory,
  hideAgents = false,
  botHome = null,
  ...props
}: PickerEntryProps & {
  /** In a bot's home its chats take the agents' place: typing an agent's name finds its side chat. */
  botHome?: { bot: Bot; agentMenu: NewTabAgentMenuModel } | null
}): React.JSX.Element {
  const entries = useAgentPickerInventoryEntries(inventory)
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const launchOptions = useMemo(
    () => buildAgentPickerLaunchOptions(entries, commandOverrides),
    [entries, commandOverrides]
  )
  if (botHome) {
    return <BotChatPickerEntry {...props} {...botHome} overrides={commandOverrides} />
  }
  return hideAgents ? (
    <TabBarCreateEntry {...props} />
  ) : (
    <TabBarCreateEntry {...props} agentPickerEntries={entries} agentOptions={launchOptions} />
  )
}

function BotChatPickerEntry({
  bot,
  agentMenu,
  overrides,
  onLaunchAgentOption,
  ...props
}: Omit<PickerEntryProps, 'inventory' | 'hideAgents'> & {
  bot: Bot
  agentMenu: NewTabAgentMenuModel
  overrides: Partial<Record<TabAgentLaunchOption['agent'], string>> | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const { startSideChat, newHomeChat } = useBotNewChatLaunch(bot)
  // The menu model is rebuilt as the query changes; key on what it offers so typing only re-matches.
  const agentsKey = botNewChatAgents(bot, agentMenu)
    .map(({ agent, unavailable }) => (unavailable ? `${agent}:${unavailable}` : agent))
    .join(',')
  const agentOptions = useMemo(
    () => buildBotNewChatSearchOptions(bot, parseBotChatAgents(agentsKey), overrides, t),
    [bot, agentsKey, overrides, t]
  )
  const launch = (option: TabAgentLaunchOption): boolean | void | Promise<boolean> => {
    if (!option.botChat) {
      return onLaunchAgentOption?.(option)
    }
    if (option.botChat.home) {
      void newHomeChat()
    } else {
      startSideChat(option.botChat.agent)
    }
    return true
  }
  return <TabBarCreateEntry {...props} agentOptions={agentOptions} onLaunchAgentOption={launch} />
}

// Agent ids and reasons hold no commas or colons.
function parseBotChatAgents(key: string): BotNewChatAgent[] {
  if (!key) {
    return []
  }
  return key.split(',').map((entry) => {
    const [agent, unavailable] = entry.split(':') as [BotAgent, ChatUnavailableReason | undefined]
    return unavailable ? { agent, unavailable } : { agent }
  })
}
