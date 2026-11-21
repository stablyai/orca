// One save of the bot settings picture: a mascot, or the kept picture (its image, or an emoji set back),
// noted in the picture ledger as acknowledged or failed. See use-bot-picture-setting.ts.
import { toast } from 'sonner'
import type { BotPictureValue } from '@/components/bots/BotPicturePicker'
import { botErrorMessage } from '@/components/bots/bot-presentation'
import { uploadBotAvatar } from '@/lib/bot-catalog'
import { botRefKey } from '@/lib/bot-hosts'
import { noteBotPictureAck, noteBotPictureFailure } from '@/components/bots/bot-picture-ops'
import {
  keepSavedPictureDescription,
  savedPictureDescription
} from '@/components/bots/generated-avatar-descriptions'
import { isUploadAvatar } from '../../../../../shared/bot-avatar'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import {
  choiceKey,
  PNG_DATA_URL_PREFIX,
  type KeptPicture,
  type SaveLoop
} from './bot-picture-setting-choices'

type SendContext = {
  bot: Bot
  live: SaveLoop
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
  setKept: (next: KeptPicture | null) => void
}

export async function sendBotPicture(
  choice: BotPictureValue,
  { bot, live, update, setKept }: SendContext
): Promise<boolean> {
  const key = botRefKey(bot)
  const acked = (saved: Bot | null): void => {
    if (saved) {
      noteBotPictureAck(key, saved.avatarRevision)
    } else {
      noteBotPictureFailure(key)
    }
  }
  if (choice.kind === 'mascot') {
    const saved = await update({ avatar: choiceKey(choice, null) })
    acked(saved)
    return saved !== null
  }
  const target = live.kept
  if (!target) {
    return false
  }
  const png =
    target.png ??
    (isUploadAvatar(target.avatar) && live.src?.startsWith(PNG_DATA_URL_PREFIX)
      ? live.src.slice(PNG_DATA_URL_PREFIX.length)
      : null)
  if (!png) {
    // An emoji or the initial is set back directly; an upload is set only by sending its image.
    if (isUploadAvatar(target.avatar)) {
      noteBotPictureFailure(key)
      return false
    }
    const saved = await update({ avatar: target.avatar })
    acked(saved)
    return saved !== null
  }
  try {
    // Read before the upload: a picture put back keeps the caption saved with its earlier avatar.
    const known = savedPictureDescription({
      id: bot.id,
      hostId: bot.hostId,
      avatar: target.avatar
    })
    const saved = await uploadBotAvatar(bot, png)
    acked(saved)
    keepSavedPictureDescription(saved, png, known)
    if (live.kept?.id === target.id) {
      setKept({ ...target, avatar: saved.avatar, replaced: undefined })
    }
    return true
  } catch (error) {
    acked(null)
    toast.error(botErrorMessage(error))
    if (live.kept?.id === target.id && target.replaced !== undefined) {
      setKept(target.replaced)
    }
    return false
  }
}
