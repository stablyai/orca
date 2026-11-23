// The Items tab's all-clear line: "Nothing needs you" in muted text at the list's top, lined up with the
// rows' text. The panel header already shows the bot, so the line carries no picture of its own.
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'

export function BotItemsAllClear(): React.JSX.Element {
  const t = useTranslate()
  return (
    // pl-8 is a row's text edge; -mb-1.5 brings the panel's 14px gap down to the 8px between sections.
    <p
      role="status"
      className="-mb-1.5 min-w-0 truncate py-1 pl-8 pr-2 text-[13px] leading-5 text-muted-foreground"
    >
      {t('bots.items.empty.allClear', 'Nothing needs you')}
    </p>
  )
}

export function renderBotGroupItemsAllClear(members: readonly Bot[]): React.JSX.Element | null {
  return members.every((bot) => bot.paused) ? null : <BotItemsAllClear />
}
