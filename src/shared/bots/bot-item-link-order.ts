import type { BotItemLinkView, BotItemWorkerState } from './bot-items'
import {
  botItemLinkRowsWithRecency,
  botItemWorkerState,
  type BotItemLinkRow
} from './bot-item-link-rows'

/** Rows an item page's Links section shows; the rest are behind "All N". */
export const BOT_ITEM_LINK_PREVIEW = 5

export function botItemLinkPreview(rows: readonly BotItemLinkRow[]): BotItemLinkRow[] {
  return rows.slice(0, BOT_ITEM_LINK_PREVIEW)
}

/** Running workers, failed workers, open or draft PRs, then the remaining links. */
function importance(row: BotItemLinkRow): number {
  if (row.kind === 'worker') {
    const state = botItemWorkerState(row.link.state)
    if (state === 'running') {
      return 0
    }
    if (state === 'failed') {
      return 1
    }
  }
  if (
    row.kind === 'github' &&
    row.type === 'pr' &&
    (row.state === 'open' || row.state === 'draft')
  ) {
    return 2
  }
  return 3
}

/** An item's link rows most important first, each tier newest first (by its newest link). */
export function botItemLinksByImportance(links: readonly BotItemLinkView[]): BotItemLinkRow[] {
  const { rows, newestAt } = botItemLinkRowsWithRecency(links)
  // Ranked once, not per comparison: an item holds up to 1,000 links.
  const rank = new Map(rows.map((row) => [row.key, importance(row)]))
  const at = (row: BotItemLinkRow): number => newestAt.get(row.key) ?? -1
  // Stable: rows from one link (a worker and its PR) keep the grouped order.
  return rows.toSorted((a, b) => (rank.get(a.key) ?? 3) - (rank.get(b.key) ?? 3) || at(b) - at(a))
}

/** The list's order, but a worker that has finished goes last: with many links, the ones still
 *  moving and the PRs keep their place in view, and a finished worker is the first behind "+N". */
export function botItemLinkChipOrder(rows: readonly BotItemLinkRow[]): BotItemLinkRow[] {
  const settled = (row: BotItemLinkRow): boolean =>
    row.kind === 'worker' && SETTLED_WORKER.has(row.link.state)
  return [...rows.filter((row) => !settled(row)), ...rows.filter(settled)]
}

const SETTLED_WORKER: ReadonlySet<BotItemWorkerState> = new Set([
  'completed',
  'failed',
  'stopped',
  'missing'
])
