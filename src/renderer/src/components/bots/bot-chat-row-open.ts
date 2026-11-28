// Opening a chat, from a row (Chats tab, its search, the sidebar, either row menu) or by its session
// alone (an item, Needs you, a request card, a link, a notification): the one place that says where a
// chat opens. The viewer's own opens in this window's tabs; another person's opens in the view
// of their tabs, picked there, and nothing of it is copied here or marked seen for them.
import { openBotHome, openBotHomeTab } from '@/lib/bot-catalog'
import { revealWorkerPane } from '@/lib/open-orchestration-worker'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { openAgentSessionHistoryModal } from '../right-sidebar/ai-vault/panel/agent-session-history-modal'
import { openBotAutomation } from './bot-automation-open'
import { openBotSession } from './bot-session-open'
import { readBotChatRow } from './use-bot-chat-tree'
import { viewerTabListPerson } from './teammate-tabs/tab-list-people'
import { chatTabListPerson, sameTabListPerson, viewTabList } from './teammate-tabs/viewed-tab-list'

export function openBotChatRow(
  bot: Bot,
  chat: Pick<BotChatTreeChat, 'chatId' | 'liveSessionId' | 'origin' | 'closed' | 'run' | 'person'>
): void {
  const { run } = chat
  if (run) {
    // A terminal run has no chat: its terminal is what opens, else its run record.
    const host = parseExecutionHostId(bot.hostId)
    if (run.worktreeId && run.paneKey) {
      revealWorkerPane(run.worktreeId, run.paneKey, host?.kind === 'runtime' ? host.id : undefined)
    } else {
      openBotAutomation(bot.hostId, run.automationId, run.runId)
    }
    return
  }
  const homeKey = folderWorkspaceKey(bot.folderWorkspaceId)
  if (chat.closed) {
    // A closed chat reads in Session History.
    openAgentSessionHistoryModal({
      workspace: { worktreeId: homeKey },
      chatTabId: structuredAgentSessionTabId(chat.chatId),
      initialQuery: '',
      alongside: true
    })
    return
  }
  const whose = chatTabListPerson(chat)
  if (!sameTabListPerson(whose, viewerTabListPerson(bot))) {
    if (openBotHome(bot)) {
      // Their tab holds the session the chat runs now (a /clear moves it past the chat id).
      viewTabList(homeKey, whose, { sessionId: chat.liveSessionId ?? chat.chatId })
    }
    return
  }
  openOwnChat(bot, chat.chatId, chat.origin === 'home')
}

/** The viewer's own chat, in this window's own tabs: any view of another person's leaves first. */
function openOwnChat(bot: Bot, sessionId: string, home: boolean): void {
  viewTabList(folderWorkspaceKey(bot.folderWorkspaceId), null)
  if (home) {
    void openBotHomeTab(bot)
  } else {
    openBotSession(bot, sessionId)
  }
}

/** A chat named only by its session opens where its row would, by whose the host says it is. One the
 *  host lists as no one's yet (just made) is the viewer's own; `home`: a Home Chat's session from
 *  before a /clear, which this viewer's Home stands for. */
export async function openBotChatById(
  bot: Bot,
  sessionId: string,
  { home = false }: { home?: boolean } = {}
): Promise<void> {
  const row = await readBotChatRow(bot, sessionId)
  if (row) {
    openBotChatRow(bot, row)
  } else {
    openOwnChat(bot, sessionId, home || sessionId === bot.chatSessionId)
  }
}
