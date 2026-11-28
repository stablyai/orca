// The one door before a chat is placed in this window's own tabs (the host's reveal, and the seen
// mark that follows it). For a shared agent's Home, unknown never means mine: only a chat known to
// be this viewer's own comes in; another person's opens in the view of their tabs, and one whose
// person can't be told opens to read alone. An agent shared with no one is unchanged.
import { botPeoplePicker } from '../../../../../shared/bots/bot-chat-people'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { openBotHome } from '@/lib/bot-catalog'
import { readBotForWorkspace } from '@/components/bots/bot-workspace'
import { readBotChatRow } from '@/components/bots/use-bot-chat-tree'
import { viewerTabListPerson } from '@/components/bots/teammate-tabs/tab-list-people'
import {
  chatTabListPerson,
  sameTabListPerson,
  viewChatOfUnknownPerson,
  viewTabList
} from '@/components/bots/teammate-tabs/viewed-tab-list'

/** Chats this window just made for its viewer (new chat, reset, hand-off): the host may not list
 *  them yet, and they are this viewer's own. */
const madeHere = new Set<string>()

export function claimChatMadeHere(sessionId: string): string {
  madeHere.add(sessionId)
  return sessionId
}

type OpenTarget = { worktreeId: string; sessionId: string; hostId: ExecutionHostId }

/** True: the chat may enter this window's own tabs. False: it was shown in a view instead. */
export async function admitToOwnTabs(target: OpenTarget): Promise<boolean> {
  const bot = readBotForWorkspace(target.worktreeId, target.hostId)
  if (!bot || botPeoplePicker(bot, null) === null) {
    return true
  }
  const { sessionId } = target
  if (sessionId === bot.chatSessionId || madeHere.has(sessionId)) {
    return true
  }
  const found = await readBotChatRow(bot, sessionId)
  const homeKey = folderWorkspaceKey(bot.folderWorkspaceId)
  if (found.kind === 'row') {
    const whose = chatTabListPerson(found.row)
    if (sameTabListPerson(whose, viewerTabListPerson(bot))) {
      return true
    }
    if (openBotHome(bot)) {
      viewTabList(homeKey, whose, { sessionId: found.row.liveSessionId ?? found.row.chatId })
    }
    return false
  }
  if (openBotHome(bot)) {
    viewChatOfUnknownPerson(homeKey, sessionId)
  }
  return false
}
