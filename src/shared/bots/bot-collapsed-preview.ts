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
export function collapsedBotPreview<T extends BotPreviewFacts>(
  bots: readonly T[],
  limit = 5,
  current?: T
) {
  const ranked = bots
    .map((bot, index) => ({
      bot,
      index,
      priority: botPreviewSignal(bot) === null ? 3 : PRIORITY[botPreviewSignal(bot)!]
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ bot }) => bot)
  const shown = ranked.slice(0, Math.max(0, Math.min(5, Math.floor(limit))))
  const hidden = ranked.slice(shown.length)
  // Keep the current chat visible without shifting faces that already fit.
  const hiddenIndex = current ? hidden.indexOf(current) : -1
  if (current && shown.length > 0 && hiddenIndex >= 0) {
    hidden.splice(hiddenIndex, 1)
    hidden.unshift(shown.at(-1)!)
    shown[shown.length - 1] = current
  }
  return {
    shown,
    hidden,
    hiddenSignal: hidden.length ? botPreviewSignal(hidden[0]!) : null,
    total: bots.length,
    attention: bots.filter((bot) => botPreviewSignal(bot) === 'attention').length,
    unread: bots.filter((bot) => bot.unread).length,
    working: bots.filter((bot) => bot.status === 'working' || bot.status === 'monitoring').length
  }
}

/** 20px faces 4px apart; reserve a circle for omitted bots before choosing the face cap. */
export function botPreviewCapacity(width: number, count: number): number {
  const circles = Math.max(0, Math.floor((width + 4) / 24))
  return Math.max(0, Math.min(5, count > circles ? circles - 1 : circles))
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
