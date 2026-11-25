import { botTarget, type BotRef } from '@/lib/bot-hosts'
import type { BotSessionActivityRow } from '../../../../shared/bots/bot-activity-model'
import { botAutomationRowOwner } from '../automations/hosts/bot-automation-row-owner'
import { openBotAutomation } from './bot-automation-open'
import { botWorkerRowOpener } from './bot-worker-open'

/** A worker's terminal or a terminal run asks in its own pane. */
export function botActivityNeedOpener(
  row: BotSessionActivityRow,
  bot: BotRef,
  needKey: string
): (() => void) | null {
  const owner = botAutomationRowOwner(row, bot)
  switch (row.kind) {
    case 'worker':
      return botWorkerRowOpener(row, botTarget(bot))
    case 'run':
      return () =>
        openBotAutomation({
          bot,
          owner,
          automationId: row.automationId,
          runId: row.runId,
          originRowKey: needKey
        })
    case 'thread':
      return null
  }
}
