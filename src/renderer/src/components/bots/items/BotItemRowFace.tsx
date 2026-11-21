import { useCallback, useContext, useSyncExternalStore } from 'react'
import { parseBotAvatar } from '../../../../../shared/bot-avatar'
import type { Bot } from '../../../../../shared/bot-types'
import { botFallback } from '../../../../../shared/bots/bot-avatar-fallback'
import { BotAvatar, BotAvatarTile } from '../BotAvatar'
import { botMascotSrc } from '../bot-mascot-color'
import { BotGroupFacePicturesContext, type BotGroupFacePictures } from './bot-group-face-pictures'

const FACE_CLASS = 'size-4 rounded-full text-[9px]'
const noop = (): void => {}

/** The row's bot in a group's merged list, beside its status glyph: item numbers repeat across bots. */
export function BotItemRowFace({ bot }: { bot: Bot }): React.JSX.Element {
  const pictures = useContext(BotGroupFacePicturesContext)
  return (
    <span className="flex h-5 shrink-0 items-center" title={bot.name}>
      {pictures ? (
        <BotPanelFace bot={bot} pictures={pictures} />
      ) : (
        <BotAvatar bot={bot} className={FACE_CLASS} />
      )}
    </span>
  )
}

/** A face whose uploaded picture the panel reads, so rows mounting as the list scrolls read nothing. */
function BotPanelFace({
  bot,
  pictures
}: {
  bot: Bot
  pictures: BotGroupFacePictures
}): React.JSX.Element {
  const parsed = parseBotAvatar(bot.avatar)
  const version = parsed?.kind === 'upload' ? parsed.version : null
  const { hostId, id } = bot
  const subscribe = useCallback(
    (notify: () => void) => (version ? pictures.watch({ hostId, id }, version, notify) : noop),
    [pictures, hostId, id, version]
  )
  const read = useCallback(
    () => (version ? pictures.read({ hostId, id }, version) : null),
    [pictures, hostId, id, version]
  )
  const upload = useSyncExternalStore(subscribe, read, read)
  const src = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor) ?? upload
  return <BotAvatarTile src={src} fallback={botFallback(bot)} className={FACE_CLASS} />
}
