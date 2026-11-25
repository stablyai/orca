import type { Bot } from '../bot-types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../workspace/identity/workspace-scope'

const immutableBotSnapshots = new WeakSet<object>()

/** Marks an array owned by Store/BotPersistence as never mutated in place after publication. */
export function markImmutableBotSnapshot<T extends readonly unknown[]>(items: T): T {
  immutableBotSnapshots.add(items)
  return items
}

export function isImmutableBotSnapshot(items: readonly unknown[] | undefined): boolean {
  return items !== undefined && immutableBotSnapshots.has(items)
}

/** Places `all` in `order` (first occurrence wins; unranked entries follow in their relative order). */
export function orderBotsBySavedOrder(all: Bot[], order: readonly string[]): Bot[] {
  if (all.length <= 1 || order.length === 0) {
    return all
  }
  const byId = new Map<string, Bot>()
  for (const bot of all) {
    byId.set(bot.id, bot)
  }
  if (byId.size === all.length) {
    const ordered: Bot[] = []
    for (const id of order) {
      const bot = byId.get(id)
      if (bot) {
        ordered.push(bot)
        byId.delete(id)
      }
    }
    for (const bot of byId.values()) {
      ordered.push(bot)
    }
    return ordered
  }
  const rankById = new Map<string, number>()
  for (let index = 0; index < order.length; index += 1) {
    const id = order[index]
    if (id !== undefined && !rankById.has(id)) {
      rankById.set(id, index)
    }
  }
  return all.sort(
    (a, b) => (rankById.get(a.id) ?? order.length) - (rankById.get(b.id) ?? order.length)
  )
}

type IndexedBotEntry<B> = {
  bot: B
  id: string
  folderWorkspaceId: string
}

function sameEntries<B extends Pick<Bot, 'id' | 'folderWorkspaceId'>>(
  entries: readonly IndexedBotEntry<B>[],
  current: readonly B[]
): boolean {
  return (
    entries.length === current.length &&
    entries.every((entry, index) => {
      const candidate = current[index]
      return (
        candidate === entry.bot &&
        candidate.id === entry.id &&
        candidate.folderWorkspaceId === entry.folderWorkspaceId
      )
    })
  )
}

export type BotLookupIndex<B extends Pick<Bot, 'id' | 'folderWorkspaceId'>> = {
  byId: (botId: string) => B | undefined
  byHome: (workspaceId: string | null | undefined) => B | null
  byHomeList: (workspaceId: string | null | undefined) => readonly B[]
  hasId: (botId: string) => boolean
}

const EMPTY_BOTS: readonly never[] = []

/** O(1) bot lookup by id and `folder:<id>` home; re-validates unbranded caller arrays for test seams. */
export function createBotLookupIndex<B extends Pick<Bot, 'id' | 'folderWorkspaceId'>>(
  readBots: () => readonly B[]
): BotLookupIndex<B> {
  let cached: {
    bots: readonly B[]
    entries: readonly IndexedBotEntry<B>[]
    byId: ReadonlyMap<string, B>
    byHome: ReadonlyMap<string, B>
  } | null = null

  const currentIndex = () => {
    const current = readBots()
    if (
      cached?.bots === current &&
      (isImmutableBotSnapshot(current) || sameEntries(cached.entries, current))
    ) {
      return cached
    }
    const byId = new Map<string, B>()
    const byHome = new Map<string, B>()
    const entries: IndexedBotEntry<B>[] = []
    for (const bot of current) {
      entries.push({ bot, id: bot.id, folderWorkspaceId: bot.folderWorkspaceId })
      if (!byId.has(bot.id)) {
        byId.set(bot.id, bot)
      }
      const homeKey = folderWorkspaceKey(bot.folderWorkspaceId)
      if (!byHome.has(homeKey)) {
        byHome.set(homeKey, bot)
      }
    }
    cached = { bots: current, entries, byId, byHome }
    return cached
  }

  const byHome = (workspaceId: string | null | undefined): B | null =>
    workspaceId && parseWorkspaceKey(workspaceId)?.type === 'folder'
      ? (currentIndex().byHome.get(workspaceId) ?? null)
      : null

  return {
    byId: (botId) => currentIndex().byId.get(botId),
    byHome,
    byHomeList: (workspaceId) => {
      const bot = byHome(workspaceId)
      return bot ? [bot] : EMPTY_BOTS
    },
    hasId: (botId) => currentIndex().byId.has(botId)
  }
}
