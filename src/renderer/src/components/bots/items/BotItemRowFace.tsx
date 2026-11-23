import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'

/** The row's bot in a group's merged list, beside its status glyph: item numbers repeat across bots. */
export function BotItemRowFace({ bot }: { bot: Bot }): React.JSX.Element {
  return (
    <span className="flex h-5 shrink-0 items-center" title={bot.name}>
      <BotAvatar bot={bot} className="size-4 rounded-full text-[9px]" />
    </span>
  )
}
