// The line a finished worker's report carries when the worker was started for an open item: the item
// as it is now, and the commands that update it.
import type { BotItem } from './bot-items'
import { botItemStatusName } from './bot-item-status-name'

export type BotItemReportFact = Pick<BotItem, 'number' | 'title' | 'status' | 'doneMeans'> & {
  /** The thread, issue or pull request the item's work started in, where its result is owed. */
  startedIn?: string
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

export function formatBotItemReportHint(item: BotItemReportFact, cli = 'orca'): string {
  const doneMeans = item.doneMeans ? oneLine(item.doneMeans) : ''
  const status = botItemStatusName(item.status, (_key, fallback) => fallback)
  return [
    `This worker's work is for item ${item.number}, "${oneLine(item.title)}" (${status}).`,
    ...(doneMeans ? [`Done means: ${doneMeans}${/[.!?]$/.test(doneMeans) ? '' : '.'}`] : []),
    `If this result changes the item, update it with ${cli} bot item <cancel|comment|done|set> ${item.number}.`,
    ...(item.startedIn
      ? [`Its work started in ${item.startedIn}: post what this result settles there.`]
      : [])
  ].join(' ')
}
