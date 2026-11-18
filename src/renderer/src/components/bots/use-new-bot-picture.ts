// A new bot's picture before it exists: a random mascot, or an upload saved once the bot is made.
// New bot and Import from another app share it.
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { uploadBotAvatar } from '@/lib/bot-catalog'
import { PICKABLE_BOT_MASCOT_IDS, isBotMascotId, mascotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botErrorMessage } from './bot-presentation'
import { BOT_MASCOT_URLS } from './bot-mascots'
import { pictureMascotIndex, type BotPictureCustom, type BotPictureValue } from './BotPicturePicker'

// Opens on a random mascot, or the one a proposal chose, so no bot is created without a picture.
function firstMascot(chosen: string | undefined): BotPictureValue {
  const index = chosen && isBotMascotId(chosen) ? PICKABLE_BOT_MASCOT_IDS.indexOf(chosen) : -1
  return {
    kind: 'mascot',
    index: index === -1 ? Math.floor(Math.random() * PICKABLE_BOT_MASCOT_IDS.length) : index
  }
}

/** An uploaded picture, placed just after the mascot it was chosen from. */
type NewBotUpload = { png: string; after: number }

export type NewBotPicture = {
  /** For BotPicturePicker. */
  value: BotPictureValue
  custom: BotPictureCustom | null
  onChange: (value: BotPictureValue) => void
  onUpload: (png: string, after: number) => void
  /** The picture shown, as an image URL. */
  src: string
  /** createBot's `avatar`: the mascot shown, or the one before an upload, which the bot keeps if the upload is refused. */
  avatar: string
  /** The upload shown, as base64 PNG; null when a mascot is. */
  shownUpload: string | null
  /** Saves an upload to the bot just made; the bot as it is afterwards. */
  saveUpload: (bot: Bot) => Promise<Bot>
  reset: () => void
}

/** `initialUpload` (base64 PNG) opens on that picture, placed first, as a shared bot's own. */
export function useNewBotPicture(mascot?: string, initialUpload?: string): NewBotPicture {
  const t = useTranslate()
  const [value, setValue] = useState<BotPictureValue>(() =>
    initialUpload ? { kind: 'custom' } : firstMascot(mascot)
  )
  const [upload, setUpload] = useState<NewBotUpload | null>(() =>
    initialUpload ? { png: initialUpload, after: -1 } : null
  )
  const custom = upload && {
    src: `data:image/png;base64,${upload.png}`,
    fallback: '',
    after: upload.after,
    description: t('bots.new.pictureUpload', 'Your image')
  }
  const showingUpload = value.kind === 'custom' && upload !== null
  const mascotId =
    PICKABLE_BOT_MASCOT_IDS[pictureMascotIndex(value, custom)] ?? PICKABLE_BOT_MASCOT_IDS[0]
  return {
    value,
    custom,
    onChange: setValue,
    onUpload: (png, after) => {
      setUpload({ png, after })
      setValue({ kind: 'custom' })
    },
    src: showingUpload && custom ? custom.src : BOT_MASCOT_URLS[mascotId],
    avatar: mascotAvatar(mascotId),
    shownUpload: showingUpload ? upload.png : null,
    saveUpload: async (bot) =>
      showingUpload
        ? // Settings can try again if the upload is refused.
          uploadBotAvatar(bot, upload.png).catch((error: unknown) => {
            toast.error(botErrorMessage(error))
            return bot
          })
        : bot,
    reset: () => {
      setValue(initialUpload ? { kind: 'custom' } : firstMascot(mascot))
      setUpload(initialUpload ? { png: initialUpload, after: -1 } : null)
    }
  }
}
