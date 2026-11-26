// The Items tab's all-clear line: "Nothing needs you" in muted text at the list's top, on the panel's
// content edge. The panel header already shows the bot, so the line carries no picture of its own.
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'

export function BotItemsAllClear(): React.JSX.Element {
  const t = useTranslate()
  return (
    // px-2 is the rows' icon edge; it wraps rather than truncate. -mb-1.5 brings the panel's 14px gap
    // down to the 8px between sections.
    <p
      role="status"
      className="-mb-1.5 min-w-0 break-words px-2 py-1 text-[13px] leading-5 text-muted-foreground"
    >
      {t('bots.items.empty.allClear', 'Nothing needs you')}
    </p>
  )
}

export function renderBotGroupItemsAllClear(members: readonly Bot[]): React.JSX.Element | null {
  return members.every((bot) => bot.paused) ? null : <BotItemsAllClear />
}
