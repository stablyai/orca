// The one test for "this tab is the bot's Home": placement, locks and pin rules all ask it.
import type { Bot } from '../bot-types'
import type { Tab } from '../workspace-layout/tab-groups/tab-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../execution-host/execution-host'
import { folderWorkspaceKey } from '../workspace/identity/workspace-scope'

type ChatTab = Pick<Tab, 'contentType' | 'entityId'>

/** The bot whose page holds `tab` is `bot`; Home is the chat its one pointer names. */
export function isBotHomeTab(tab: ChatTab, bot: Pick<Bot, 'chatSessionId'> | null): boolean {
  return (
    bot !== null &&
    bot.chatSessionId !== null &&
    tab.contentType === 'agent-session' &&
    tab.entityId === bot.chatSessionId
  )
}

type HostedBotHome = Pick<Bot, 'chatSessionId' | 'folderWorkspaceId'> & { hostId: ExecutionHostId }
type HostedChatTab = ChatTab & Pick<Tab, 'worktreeId' | 'executionHostId'>

/** Whether chats saved without a host in the bot's workspace are this app's: only its records can say. */
export type HostlessChatsAreLocal = () => boolean
const NO_HOSTLESS_CHATS: HostlessChatsAreLocal = () => false

/**
 * The dedicated home workspace and owning host identify its chats, never their names or order.
 * A chat saved without a host is a local bot's only when `hostlessAreLocal` vouches for the
 * workspace; a paired or SSH bot never claims one.
 */
export function isHostedBotChatTab(
  tab: HostedChatTab,
  bot: HostedBotHome | null,
  hostlessAreLocal: HostlessChatsAreLocal = NO_HOSTLESS_CHATS
): boolean {
  return (
    bot !== null &&
    tab.worktreeId === folderWorkspaceKey(bot.folderWorkspaceId) &&
    tab.contentType === 'agent-session' &&
    (tab.executionHostId
      ? tab.executionHostId === bot.hostId
      : bot.hostId === LOCAL_EXECUTION_HOST_ID && hostlessAreLocal())
  )
}

export function isLocalBotChatTab(
  tab: HostedChatTab,
  bot: HostedBotHome | null,
  hostlessAreLocal?: HostlessChatsAreLocal
): boolean {
  return bot?.hostId === LOCAL_EXECUTION_HOST_ID && isHostedBotChatTab(tab, bot, hostlessAreLocal)
}

export function isBotSideChatTab(
  tab: HostedChatTab,
  bot: HostedBotHome | null,
  hostlessAreLocal?: HostlessChatsAreLocal
): boolean {
  return (
    bot?.chatSessionId != null &&
    isHostedBotChatTab(tab, bot, hostlessAreLocal) &&
    !isBotHomeTab(tab, bot)
  )
}

/** Publication precedes age: a preview cannot displace the oldest ready Home. */
export function selectLocalBotHomeTabs(
  tabs: readonly Tab[],
  bot: HostedBotHome,
  hostlessAreLocal?: HostlessChatsAreLocal
): { home: Tab; duplicates: Tab[] } | null {
  const homes = tabs
    .filter((tab) => isLocalBotChatTab(tab, bot, hostlessAreLocal) && isBotHomeTab(tab, bot))
    .sort(
      (left, right) =>
        Number(left.isPreview === true) - Number(right.isPreview === true) ||
        left.createdAt - right.createdAt ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    )
  const [home, ...duplicates] = homes
  return home && !home.isPreview ? { home, duplicates } : null
}
