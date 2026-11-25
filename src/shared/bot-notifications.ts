import type { Bot, BotNotifications } from './bot-types'
import type { agentSessionAttentionNews } from './agent-session/view/agent-session-attention'
import { folderWorkspaceKey } from './workspace/identity/workspace-scope'

type AttentionNews = NonNullable<ReturnType<typeof agentSessionAttentionNews>>

/** Which of a bot's notification switches covers this news. */
export function botNotificationFor(news: AttentionNews): keyof BotNotifications {
  if (news.agentState === 'blocked') {
    return 'needsPermission'
  }
  return news.outcome === 'success' ? 'taskComplete' : 'couldNotFinish'
}

/** A bot's switch off silences that news from its home: no unread, banner, sound or push. */
export function isBotAttentionSilenced(
  bots: readonly Pick<Bot, 'folderWorkspaceId' | 'notifications'>[],
  workspaceId: string,
  news: AttentionNews
): boolean {
  const bot = bots.find(
    (candidate) => folderWorkspaceKey(candidate.folderWorkspaceId) === workspaceId
  )
  return bot !== undefined && !bot.notifications[botNotificationFor(news)]
}
