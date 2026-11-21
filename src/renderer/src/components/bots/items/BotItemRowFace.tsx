import { useContext } from 'react'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import { botFallback } from '../../../../../shared/bots/bot-avatar-fallback'
import { BotAvatar, BotAvatarTile } from '../BotAvatar'
import { BotAvatarSrcs } from '../bot-avatar-image'

const FACE_CLASS = 'size-4 rounded-full text-[9px]'

/** The row's bot in a group's merged list, beside its status glyph: item numbers repeat across bots.
 *  Inside a list that reads its bots' pictures once, a row drawn again shows it with no read of its own. */
export function BotItemRowFace({ bot }: { bot: Bot }): React.JSX.Element {
  const srcs = useContext(BotAvatarSrcs)
  return (
    <span className="flex h-5 shrink-0 items-center" title={bot.name}>
      {srcs ? (
        <BotAvatarTile
          src={srcs.get(botRefKey(bot)) ?? null}
          fallback={botFallback(bot)}
          className={FACE_CLASS}
        />
      ) : (
        <BotAvatar bot={bot} className={FACE_CLASS} />
      )}
    </span>
  )
}
