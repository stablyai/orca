// The Links block's order: the list's own, but a worker that has finished goes last.
import type { BotItemWorkerState } from '../../../../../shared/bots/bot-items'
import type { BotItemLinkRow } from '../../../../../shared/bots/bot-item-link-rows'

const SETTLED_WORKER: ReadonlySet<BotItemWorkerState> = new Set([
  'completed',
  'failed',
  'stopped',
  'missing'
])

/** The list's order, but a worker that has finished goes last: the ones still moving and the PRs keep
 *  their place in the first rows, and a finished worker is the first behind "N more". */
export function botItemLinksOrder(rows: readonly BotItemLinkRow[]): BotItemLinkRow[] {
  const settled = (row: BotItemLinkRow): boolean =>
    row.kind === 'worker' && SETTLED_WORKER.has(row.link.state)
  return [...rows.filter((row) => !settled(row)), ...rows.filter(settled)]
}
