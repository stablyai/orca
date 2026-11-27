import { useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import {
  useAgentPickerInventoryEntries,
  type AgentPickerInventorySource
} from '../../agent/agent-picker-inventory-source'
import type { NewTabAgentMenuModel } from '../../agent/launch-menu/new-tab-agent-menu-model'
import { buildBotNewChatSearchOptions } from '../../bots/bot-new-chat-search-options'
import { useBotNewChatLaunch } from '../../bots/use-bot-new-chat-launch'
import { botNewChatAgents } from '../../../../../shared/bots/bot-agent-choices'
import type { Bot } from '../../../../../shared/bot-types'
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
  // The menu model is a new object on every parent render; keep the offered agents until what
  // they say changes, so only a real inventory or availability change rebuilds the options.
  const agents = botNewChatAgents(bot, agentMenu)
  const agentsKey = agents
    .map(({ agent, unavailable }) => (unavailable ? `${agent}:${unavailable}` : agent))
    .join(',')
  const [offered, setOffered] = useState({ key: agentsKey, agents })
  if (offered.key !== agentsKey) {
    setOffered({ key: agentsKey, agents })
  }
  const agentOptions = useMemo(
    () => buildBotNewChatSearchOptions(bot, offered.agents, overrides, t),
    [bot, offered.agents, overrides, t]
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
