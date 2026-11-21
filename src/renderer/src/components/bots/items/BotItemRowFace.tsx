import { useContext, useMemo } from 'react'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'
import { BotItemFaceReadsContext } from './bot-item-face-reads'

const FACE_CLASS = 'size-4 rounded-full text-[9px]'

/** The row's bot in a group's merged list, beside its status glyph: item numbers repeat across bots.
 *  `windowed`: the row mounts as its list scrolls, so its picture isn't read while the host is offline,
 *  and a read that failed while the group is shown isn't read again by each row scrolled in (the host
 *  coming back, or reopening the group, reads it again). */
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
  const reads = useContext(BotItemFaceReadsContext)
  const paused = reads ? !reads.live.has(bot.hostId) : false
  const failures = reads?.failures ?? null
  const read = useMemo(() => ({ paused, failures }), [paused, failures])
  return <BotAvatar bot={bot} className={FACE_CLASS} read={read} />
}
