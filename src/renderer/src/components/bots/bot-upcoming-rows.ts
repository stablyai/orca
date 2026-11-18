// Upcoming in a bot's Activity list: its routines, automations and waits as one list in a fixed order.
import type { Bot } from '../../../../shared/bot-types'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import { botLookAround, lookAroundSupported } from '../../../../shared/bots/bot-look-around'
import { botTidyUp } from '../../../../shared/bots/bot-tidy-up'

export type BotUpcomingRow = { key: string; on: boolean } & (
  | { kind: 'look-around' }
  | { kind: 'tidy-up' }
  | { kind: 'automation'; row: BotAutomationRow }
  | { kind: 'wait'; row: BotAutomationRow }
)

/** Oldest first, so a row never moves when its switch flips; hosts before `createdAt` order by id. */
function byCreation(a: BotAutomationRow, b: BotAutomationRow): number {
  return (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

export function botUpcomingRows(
  bot: Bot,
  activity: Pick<BotActivity, 'automations' | 'waits'>
): BotUpcomingRow[] {
  const rows: BotUpcomingRow[] = []
  // Tidy memory and Look around run only for agents Orca can hold to reads.
  if (lookAroundSupported(bot.agent)) {
    rows.push({ kind: 'tidy-up', key: 'tidy-up', on: botTidyUp(bot).on })
    rows.push({ kind: 'look-around', key: 'look-around', on: botLookAround(bot).on })
  }
  for (const row of [...activity.automations].sort(byCreation)) {
    rows.push({ kind: 'automation', key: `automation:${row.key}`, row, on: row.automation.enabled })
  }
  // Waits keep the host's order, soonest due first; they have no switch to flip.
  for (const row of activity.waits) {
    rows.push({ kind: 'wait', key: `wait:${row.key}`, row, on: true })
  }
  return rows
}
