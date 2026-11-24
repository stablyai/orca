// The items an open item steps through: the list it opened from, filters applied, in list order, fixed
// when it opened. Closed items not paged in yet count toward the total and are read as the walk
// reaches them; items arriving later (new, or closed since) show in the list after Back.
import type { BotItem } from './bot-items'
import { BOT_ITEM_GROUP_IDS, type BotItemGroups } from './bot-item-groups'

export type BotItemWalk = {
  /** Known members in list order: the loaded ones, then Closed ones as their pages arrive. */
  uids: readonly string[]
  /** Members on the host, the unloaded Closed ones included. */
  total: number
}

export type BotItemWalkStep =
  | { kind: 'open'; uid: string }
  /** The next member is a Closed item not paged in yet. */
  | { kind: 'page' }

export function botItemWalkOf(groups: BotItemGroups, closedTotal: number): BotItemWalk {
  const uids = BOT_ITEM_GROUP_IDS.flatMap((id) => groups[id].map((item) => item.uid))
  return { uids, total: uids.length + Math.max(0, closedTotal - groups.closed.length) }
}

/** Where `uid` is (0-based), or null when it isn't in the walk. */
export function botItemWalkIndex(walk: BotItemWalk, uid: string): number | null {
  const index = walk.uids.indexOf(uid)
  return index === -1 ? null : index
}

/** The step from `uid`, or null at either end (there is no wrap-around). */
export function botItemWalkStep(
  walk: BotItemWalk,
  uid: string,
  direction: 1 | -1
): BotItemWalkStep | null {
  const index = botItemWalkIndex(walk, uid)
  if (index === null) {
    return null
  }
  const to = index + direction
  if (to < 0 || to >= walk.total) {
    return null
  }
  return to < walk.uids.length ? { kind: 'open', uid: walk.uids[to] } : { kind: 'page' }
}

/** Fills in unloaded members from a Closed page read since, de-duplicated by uid. Only the members
 *  counted at open are taken: an item closed after opening waits for Back. `ended` when the host has
 *  no more pages. */
export function botItemWalkExtend(
  walk: BotItemWalk,
  page: readonly BotItem[],
  ended: boolean
): BotItemWalk {
  const known = new Set(walk.uids)
  const unknown = walk.total - walk.uids.length
  const added = page
    .flatMap((item) => (known.has(item.uid) ? [] : [item.uid]))
    .slice(0, Math.max(0, unknown))
  const uids = added.length > 0 ? [...walk.uids, ...added] : walk.uids
  const total = ended ? uids.length : walk.total
  return uids === walk.uids && total === walk.total ? walk : { uids, total }
}

/** Without a deleted member. */
export function botItemWalkDrop(walk: BotItemWalk, uid: string): BotItemWalk {
  return walk.uids.includes(uid)
    ? { uids: walk.uids.filter((entry) => entry !== uid), total: walk.total - 1 }
    : walk
}

/** The row Back focuses: `uid`'s own, else the nearest walk member still listed after it, then
 *  before it, else the list's last row. */
export function botItemWalkReturnRow(
  walk: BotItemWalk | null,
  uid: string,
  listed: readonly string[]
): string | null {
  const shown = new Set(listed)
  if (shown.has(uid)) {
    return uid
  }
  const index = walk ? botItemWalkIndex(walk, uid) : null
  if (walk && index !== null) {
    const after = walk.uids.slice(index + 1).find((entry) => shown.has(entry))
    const before = walk.uids.slice(0, index).findLast((entry) => shown.has(entry))
    const near = after ?? before
    if (near) {
      return near
    }
  }
  return listed.at(-1) ?? null
}
