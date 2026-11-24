// The bot settings picture's tile color and outfit: each pick saves on its own after a pause (see
// useBotLookSave), and each save's revision goes to the picture ledger, so a picture generated meanwhile
// requires it.
import { noteBotPictureSaved } from '@/components/bots/bot-picture-ops'
import { botHostHas } from '@/lib/bot-host-status'
import { BOTS_AVATAR_REVISION_RUNTIME_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import { botRefKey } from '@/lib/bot-hosts'
import { beginBotHostUpdate } from '@/lib/bot-host-refresh'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { wornBotOutfit, type BotAvatarOutfit } from '../../../../../shared/bots/bot-avatar-outfit'
import { BOT_PICTURE_SAVE_DELAY_MS } from './bot-picture-setting-choices'
import { useBotLookSave } from './use-bot-look-save'

export function useBotPictureLook(
  bot: Bot,
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
): {
  /** The mascot's tile color shown; null is its own sky blue. */
  color: string | null
  pickColor: (color: string | null) => void
  /** What the mascot wears shown; null is nothing. */
  outfit: BotAvatarOutfit | null
  pickOutfit: (outfit: BotAvatarOutfit | null) => void
  /** Saves a pick still waiting on its pause (Settings closing). */
  flush: () => void
} {
  const key = botRefKey(bot)
  const look = useBotLookSave(
    key,
    (updates) =>
      update({
        ...updates,
        ...(botHostHas(bot.hostId, BOTS_AVATAR_REVISION_RUNTIME_CAPABILITY)
          ? { lookAtRevision: bot.avatarRevision ?? 0 }
          : {})
      }).then((saved) => {
        noteBotPictureSaved(key, saved)
        return saved
      }),
    BOT_PICTURE_SAVE_DELAY_MS,
    () => beginBotHostUpdate(bot.hostId)
  )
  const { picked } = look
  return {
    color:
      picked && 'avatarColor' in picked ? (picked.avatarColor ?? null) : (bot.avatarColor ?? null),
    pickColor: (color) => {
      look.pick({ avatarColor: color })
    },
    outfit: wornBotOutfit(
      picked && 'avatarOutfit' in picked ? picked.avatarOutfit : bot.avatarOutfit
    ),
    pickOutfit: (outfit) => {
      look.pick({ avatarOutfit: outfit })
    },
    flush: look.flush
  }
}
