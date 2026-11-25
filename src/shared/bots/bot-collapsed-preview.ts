import type { WorktreeStatus } from '../worktree/row-display/worktree-status-rollup'
import { rollUpBotStatus } from './bot-sidebar-workspaces'

export type BotPreviewFacts = {
  status: WorktreeStatus
  unread: boolean
  paused: boolean
  attention?: boolean
}
export type BotPreviewSignal = 'attention' | 'unread' | 'working' | null

export function botPreviewSignal(bot: BotPreviewFacts): BotPreviewSignal {
  if (bot.attention || botStatusNeedsAttention(bot.status)) {
    return 'attention'
  }
  if (bot.unread) {
    return 'unread'
  }
  return bot.status === 'working' || bot.status === 'monitoring' ? 'working' : null
}

const PRIORITY = { attention: 0, unread: 1, working: 2 }

/** Only the collapsed preview ranks bots; ties retain the host's saved order. */
export function rankBotsForPreview<T extends BotPreviewFacts>(bots: readonly T[]): T[] {
  return bots
    .map((bot, index) => {
      const signal = botPreviewSignal(bot)
      return { bot, index, priority: signal === null ? 3 : PRIORITY[signal] }
    })
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ bot }) => bot)
}

export function summarizeBotPreview(bots: readonly BotPreviewFacts[]) {
  return {
    total: bots.length,
    attention: bots.filter((bot) => botPreviewSignal(bot) === 'attention').length,
    unread: bots.filter((bot) => bot.unread).length,
    working: bots.filter((bot) => bot.status === 'working' || bot.status === 'monitoring').length
  }
}

export function botStatusNeedsAttention(status: WorktreeStatus): boolean {
  return status === 'permission' || status === 'failed' || status === 'unconfirmed'
}

/** A bot's face in the folded header: the busiest of it and its workspaces. Unread is its home's
 *  alone; new Up next suggestions aren't messages, so the row counts them on its own. */
export function botPreviewFacts(input: {
  own: WorktreeStatus
  workspaces: readonly WorktreeStatus[]
  homeUnread: boolean
  paused: boolean
}): BotPreviewFacts {
  return {
    status: rollUpBotStatus(input.own, input.workspaces),
    attention: [input.own, ...input.workspaces].some(botStatusNeedsAttention),
    unread: input.homeUnread,
    paused: input.paused
  }
}
