import { createContext, useContext } from 'react'
import type { Bot } from '../../../../../shared/bot-types'
import { botFallback } from '../../../../../shared/bots/bot-avatar-fallback'
import { BotAvatar, BotAvatarTile } from '../BotAvatar'

/** The panel's pictures for its bots (useBotAvatarSrcs): rows mount as a long list scrolls, so they
 *  take their bot's picture from the panel instead of reading it each time. */
export const BotItemFaceSrcs = createContext<((bot: Bot) => string | null | undefined) | null>(null)

/** The row's bot in a group's merged list, beside its status glyph: item numbers repeat across bots. */
export function BotItemRowFace({ bot }: { bot: Bot }): React.JSX.Element {
  const src = useContext(BotItemFaceSrcs)?.(bot)
  const className = 'size-4 rounded-full text-[9px]'
  return (
    <span className="flex h-5 shrink-0 items-center" title={bot.name}>
      {src === undefined ? (
        <BotAvatar bot={bot} className={className} />
      ) : (
        <BotAvatarTile src={src} fallback={botFallback(bot)} className={className} />
      )}
    </span>
  )
}
