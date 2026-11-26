import type { BotChangeKind, BotChangeScope, BotNeedsYouCounts } from './bot-change-scope'

/** The scope a runtime event carries, read loosely (a peer of another version may send anything). */
export function readBotChangeScope(event: unknown): BotChangeScope | undefined {
  if (!event || typeof event !== 'object') {
    return undefined
  }
  const botIds =
    'botIds' in event && Array.isArray(event.botIds)
      ? event.botIds.filter((id): id is string => typeof id === 'string')
      : undefined
  const kinds =
    'kinds' in event && Array.isArray(event.kinds)
      ? event.kinds.filter((kind): kind is BotChangeKind => typeof kind === 'string')
      : undefined
  const kindBots = 'kindBots' in event ? readStringLists(event.kindBots) : undefined
  const needsYou = 'needsYou' in event ? readBotNeedsYouCounts(event.needsYou) : undefined
  const groupPosts = 'groupPosts' in event ? readStringLists(event.groupPosts) : undefined
  const overflowRoomPosts =
    'overflowRoomPosts' in event && Array.isArray(event.overflowRoomPosts)
      ? event.overflowRoomPosts.filter((id): id is string => typeof id === 'string')
      : undefined
  // Kept as sent: only an open room walks it, once per notice.
  // A notice read once already (the preload's, a paired host's) carries it as `receivedGroupIds`.
  const receivedGroupIds: readonly unknown[] | undefined =
    'groupIds' in event && Array.isArray(event.groupIds)
      ? event.groupIds
      : 'receivedGroupIds' in event && Array.isArray(event.receivedGroupIds)
        ? event.receivedGroupIds
        : undefined
  return botIds || kinds
    ? {
        ...(botIds ? { botIds } : {}),
        ...(kinds ? { kinds } : {}),
        ...(kindBots ? { kindBots } : {}),
        ...(needsYou ? { needsYou } : {}),
        ...(groupPosts ? { groupPosts } : {}),
        ...(overflowRoomPosts ? { overflowRoomPosts } : {}),
        ...('scopedRoomPosts' in event && event.scopedRoomPosts === true
          ? { scopedRoomPosts: true as const }
          : {}),
        ...('roomPostsOnly' in event && event.roomPostsOnly === true
          ? { roomPostsOnly: true as const }
          : {}),
        ...(receivedGroupIds ? { receivedGroupIds } : {})
      }
    : undefined
}

/** `readBotChangeScope` with the items it names (`itemUids`, `namesItems`), for Items lists that read
 *  just those; kept apart so readers that don't stay as small as they were. */
export function readBotChangeScopeWithItems(event: unknown): BotChangeScope | undefined {
  const scope = readBotChangeScope(event)
  if (!scope || !event || typeof event !== 'object') {
    return scope
  }
  const itemUids = 'itemUids' in event ? readStringLists(event.itemUids) : undefined
  return {
    ...scope,
    ...(itemUids ? { itemUids } : {}),
    ...('namesItems' in event && event.namesItems === true ? { namesItems: true as const } : {})
  }
}

/** A record of string lists (`kindBots`, `itemUids`), read loosely. */
function readStringLists(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const out: Record<string, string[]> = {}
  for (const [kind, bots] of Object.entries(value)) {
    if (Array.isArray(bots)) {
      out[kind] = bots.filter((id): id is string => typeof id === 'string')
    }
  }
  return out
}

function readBotNeedsYouCounts(value: unknown): BotNeedsYouCounts | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('at' in value) ||
    typeof value.at !== 'number' ||
    !('counts' in value) ||
    !value.counts ||
    typeof value.counts !== 'object'
  ) {
    return undefined
  }
  const counts: Record<string, number> = {}
  for (const [botId, count] of Object.entries(value.counts)) {
    if (typeof count === 'number') {
      counts[botId] = count
    }
  }
  const staleInMs =
    'staleInMs' in value && typeof value.staleInMs === 'number' ? value.staleInMs : undefined
  return { counts, at: value.at, ...(staleInMs !== undefined ? { staleInMs } : {}) }
}
