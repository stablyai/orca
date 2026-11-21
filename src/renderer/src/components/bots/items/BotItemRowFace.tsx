import { useContext, useMemo } from 'react'
import { useBotHostLive } from '@/lib/bot-host-views'
import { parseBotAvatar } from '../../../../../shared/bot-avatar'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'
import { isBotAvatarRead } from '../bot-avatar-image'
import { BotItemFaceFailuresContext } from './bot-item-face-reads'

/** The row's bot in a group's merged list, beside its status glyph: item numbers repeat across bots.
 *  `windowed`: the row mounts as its list scrolls, so its picture isn't read while the host is offline,
 *  and a read that failed while the group is shown isn't read again by each row scrolled in (the host
 *  coming back, or reopening the group, reads it again). The same face either way, so a group growing
 *  long remounts none. */
export function BotItemRowFace({
  bot,
  windowed = false
}: {
  bot: Bot
  windowed?: boolean
}): React.JSX.Element {
  const failures = useContext(BotItemFaceFailuresContext)
  // Only a face still to read an upload reads anything, so only it hears its host and the window.
  const parsed = parseBotAvatar(bot.avatar)
  const upload = parsed?.kind === 'upload' ? parsed.version : null
  const live = useBotHostLive(
    bot.hostId,
    windowed && upload !== null && !isBotAvatarRead(bot, upload)
  )
  const read = useMemo(() => ({ paused: !live, failures }), [live, failures])
  return (
    <span className="flex h-5 shrink-0 items-center" title={bot.name}>
      <BotAvatar bot={bot} className="size-4 rounded-full text-[9px]" read={read} />
    </span>
  )
}
