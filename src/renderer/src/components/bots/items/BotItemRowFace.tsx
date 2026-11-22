import { useContext, useSyncExternalStore } from 'react'
import { parseBotAvatar } from '../../../../../shared/bot-avatar'
import type { Bot } from '../../../../../shared/bot-types'
import { botFallback } from '../../../../../shared/bots/bot-avatar-fallback'
import { BotAvatar, BotAvatarTile } from '../BotAvatar'
import { useBotMascotLayers } from '../bot-mascot-look'
import {
  BotGroupFacePicturesContext,
  BotItemFaceFolded,
  type BotGroupFacePicture,
  type BotGroupFacePictures
} from './bot-group-face-pictures'

const FACE_CLASS = 'size-4 rounded-full text-[9px]'
const NO_UPLOAD: BotGroupFacePicture = { subscribe: () => () => {}, read: () => null }

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

/** A face whose uploaded picture the panel asks for, so rows mounting as the list scrolls read nothing;
 *  one in a folded row asks for nothing until it shows. */
function BotPanelFace({
  bot,
  pictures
}: {
  bot: Bot
  pictures: BotGroupFacePictures
}): React.JSX.Element {
  const parsed = parseBotAvatar(bot.avatar)
  const folded = useContext(BotItemFaceFolded)
  const handle = parsed?.kind === 'upload' ? pictures.faceOf(bot, parsed.version) : NO_UPLOAD
  const picture = folded ? (handle.folded ?? handle) : handle
  const upload = useSyncExternalStore(picture.subscribe, picture.read, picture.read)
  const look = useBotMascotLayers(
    parsed?.kind === 'mascot' ? parsed.id : null,
    bot.avatarColor,
    bot.avatarOutfit
  )
  return (
    <BotAvatarTile
      src={look?.src ?? upload}
      outfit={look?.outfit}
      fallback={botFallback(bot)}
      className={FACE_CLASS}
    />
  )
}
