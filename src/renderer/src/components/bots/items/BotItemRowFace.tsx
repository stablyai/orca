import { useBotHostOffline } from '@/lib/bot-host-views'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'

const FACE_CLASS = 'size-4 rounded-full text-[9px]'

/** The row's bot in a group's merged list, beside its status glyph: item numbers repeat across bots.
 *  `windowed`: the row mounts as its list scrolls, so while the bot's host is offline its picture isn't
 *  read (each row scrolled in would read it again); it's read when the host is back. */
export function BotItemRowFace({
  bot,
  windowed = false
}: {
  bot: Bot
  windowed?: boolean
}): React.JSX.Element {
  return (
    <span className="flex h-5 shrink-0 items-center" title={bot.name}>
      {windowed ? <WindowedFace bot={bot} /> : <BotAvatar bot={bot} className={FACE_CLASS} />}
    </span>
  )
}

function WindowedFace({ bot }: { bot: Bot }): React.JSX.Element {
  const offline = useBotHostOffline(bot.hostId)
  return <BotAvatar bot={bot} className={FACE_CLASS} paused={offline} />
}
