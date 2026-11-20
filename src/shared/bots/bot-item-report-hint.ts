// The line a finished worker's report carries when the worker was started for an open item: the item
// as it is now, and the commands that update it.
import type { BotItem } from './bot-items'
import { botItemStatusName } from './bot-item-status-name'

export type BotItemReportFact = Pick<BotItem, 'number' | 'title' | 'status' | 'doneMeans'>

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

export function formatBotItemReportHint(item: BotItemReportFact, cli = 'orca'): string {
  const doneMeans = item.doneMeans ? oneLine(item.doneMeans) : ''
  const status = botItemStatusName(item.status, (_key, fallback) => fallback)
  return [
    `This worker was started for item ${item.number}, "${oneLine(item.title)}" (${status}).`,
    ...(doneMeans ? [`Done means: ${doneMeans}${/[.!?]$/.test(doneMeans) ? '' : '.'}`] : []),
    `If this result changes the item, update it with ${cli} bot item <cancel|comment|done|set> ${item.number}.`
  ].join(' ')
}
