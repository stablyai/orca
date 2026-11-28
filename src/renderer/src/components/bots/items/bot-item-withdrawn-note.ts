import type { Translate } from '@/i18n/use-translate'
import { botItemAskWithdrawnOf } from '../../../../../shared/bots/bot-item-ask-while'
import { formatBotItemSnoozeTime } from './bot-item-snooze-time'

/** Why Orca withdrew an ask, in the reader's language; null for any other move. */
export function botItemWithdrawnNote(data: Record<string, unknown>, t: Translate): string | null {
  const withdrawn = data.cause === 'withdrawn' ? botItemAskWithdrawnOf(data.withdrawn) : null
  if (!withdrawn) {
    return null
  }
  if (withdrawn.kind === 'until') {
    return t('bots.items.activity.withdrawnTimePassed', 'Ask withdrawn — {{time}} passed', {
      time: formatBotItemSnoozeTime(withdrawn.at, Date.now())
    })
  }
  const name = withdrawn.title ? `"${withdrawn.title}"` : withdrawn.ref
  return withdrawn.state === 'completed'
    ? t('bots.items.activity.withdrawnWorkerFinished', 'Ask withdrawn — worker {{name}} finished', {
        name
      })
    : withdrawn.state === 'failed'
      ? t('bots.items.activity.withdrawnWorkerFailed', 'Ask withdrawn — worker {{name}} failed', {
          name
        })
      : t(
          'bots.items.activity.withdrawnWorkerStopped',
          'Ask withdrawn — worker {{name}} was stopped',
          { name }
        )
}
