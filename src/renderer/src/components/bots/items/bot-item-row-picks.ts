// Rows of a long group found again after an update: by uid, looked for first where they were.
import type { BotItem } from '../../../../../shared/bots/bot-items'

export function bandOf(items: readonly BotItem[], start: number, end: number): RowPick[] {
  return items.slice(start, end).map((item, offset) => ({ uid: item.uid, at: start + offset }))
}

export const sameBand = (a: readonly RowPick[], b: readonly RowPick[]): boolean =>
  a.length === b.length && a.every((pick, index) => samePick(pick, b[index]!))

/** A row by its uid and where it was: found there at once unless the rows have moved since. */
export type RowPick = { uid: string; at: number }

export type IndexOf = (pick: RowPick | null) => number
/** How far from where it was a pick is looked for before the whole list is indexed. */
export const NEAR_ROWS = 8

/** Finds picks in one shown list: at once where they were, else by one index of the list, built on the
 *  first miss and shared by every pick. -1 for a row that left. */
export function indexOfPicks(items: readonly BotItem[]): IndexOf {
  let byUid: Map<string, number> | null = null
  return (pick) => {
    if (pick === null) {
      return -1
    }
    // A row an update moved a few places (rows above it added, removed or sorted) is found close by.
    for (let distance = 0; distance <= NEAR_ROWS; distance++) {
      if (items[pick.at + distance]?.uid === pick.uid) {
        return pick.at + distance
      }
      if (distance > 0 && items[pick.at - distance]?.uid === pick.uid) {
        return pick.at - distance
      }
    }
    byUid ??= new Map(items.map((item, index) => [item.uid, index]))
    return byUid.get(pick.uid) ?? -1
  }
}

export const relocated = (pick: RowPick | null, at: number): RowPick | null =>
  pick === null || pick.at === at ? pick : at < 0 ? null : { uid: pick.uid, at }

export const samePick = (a: RowPick | null, b: RowPick | null): boolean =>
  a === b || (a !== null && b !== null && a.uid === b.uid && a.at === b.at)
