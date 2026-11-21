import { useEffect, useMemo } from 'react'
import { useBotHostOffline } from '@/lib/bot-host-views'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'
import { forgetBotAvatarFailure } from '../bot-avatar-image'

const FACE_CLASS = 'size-4 rounded-full text-[9px]'

/** The row's bot in a group's merged list, beside its status glyph: item numbers repeat across bots.
 *  `windowed`: the row mounts as its list scrolls, so a failed picture read isn't retried by each row
 *  scrolled in: it's read again once the host is back (or another face reads it), and not while the
 *  host is offline. */
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
  const { hostId, id } = bot
  useEffect(() => {
    if (offline) {
      forgetBotAvatarFailure({ hostId, id })
    }
  }, [offline, hostId, id])
  const read = useMemo(() => ({ paused: offline, keepFailure: true }), [offline])
  return <BotAvatar bot={bot} className={FACE_CLASS} read={read} />
}
