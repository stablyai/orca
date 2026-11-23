// A new bot's picture before it exists: a random mascot, or an upload saved once the bot is made.
// New bot and Import from another app share it.
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { uploadBotAvatar } from '@/lib/bot-catalog'
import { useBotHostHas } from '@/lib/bot-host-status'
import {
  BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY,
  BOTS_AVATAR_OUTFIT_RUNTIME_CAPABILITY
} from '../../../../shared/bot-runtime-capabilities'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { PICKABLE_BOT_MASCOT_IDS, isBotMascotId, mascotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botErrorMessage } from './bot-presentation'
import { useBotMascotLook, type BotOutfitArt } from './bot-mascot-look'
import { wornBotOutfit, type BotAvatarOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import {
  generatedPictureDescription,
  keepSavedPictureDescription
} from './generated-avatar-descriptions'
import { pictureMascotIndex, type BotPictureCustom, type BotPictureValue } from './BotPicturePicker'
import { noteBotPictureChoice } from './bot-picture-ops'
import { newAvatarDraftKey } from './use-avatar-generation'

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
  /** A picture taken by paste, drop or upload: it replaces the custom one in place, or lands beside the
   *  mascot shown. */
  placeUpload: (png: string) => void
  /** The mascot's tile color; null is its own sky blue. */
  color: string | null
  /** Absent when the host can't store a color. */
  onColorChange?: (color: string | null) => void
  /** What the mascot wears; null is nothing. */
  outfit: BotAvatarOutfit | null
  /** Absent when the host can't store an outfit. */
  onOutfitChange?: (outfit: BotAvatarOutfit | null) => void
  /** The picture shown, as an image URL. */
  src: string
  /** The outfit's art, drawn over `src`. */
  outfitArt: BotOutfitArt | null
  /** createBot's `avatar`: the mascot shown, or the one before an upload, which the bot keeps if the upload is refused. */
  avatar: string
  /** createBot's `avatarColor`: set only when a mascot is shown on another color. */
  avatarColor: string | undefined
  /** createBot's `avatarOutfit`: set only when a mascot is shown wearing one, or a shared one this version
   *  doesn't draw, which the bot keeps for a newer Orca. */
  avatarOutfit: string | undefined
  /** The upload shown, as base64 PNG; null when a mascot is. */
  shownUpload: string | null
  /** Saves an upload to the bot just made; the bot as it is afterwards. */
  saveUpload: (bot: Bot) => Promise<Bot>
  reset: () => void
  /** Names the mascot, color and outfit choices in the picture ledger, so a picture still being generated
   *  doesn't land on top of a newer one. */
  choiceKey: string
}

/** `initialUpload` (base64 PNG) opens on that picture, placed first, as a shared bot's own; `look` opens
 *  the mascot on a shared bot's tile color and outfit; `host` says whether the host stores them. */
/** Whether the host saves a tile color and an outfit with a new bot. */
export function useNewBotHostLooks(hostId: ExecutionHostId): { colors: boolean; outfits: boolean } {
  return {
    colors: useBotHostHas(hostId, BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY),
    outfits: useBotHostHas(hostId, BOTS_AVATAR_OUTFIT_RUNTIME_CAPABILITY)
  }
}

export function useNewBotPicture(
  host: { colors: boolean; outfits: boolean },
  mascot?: string,
  initialUpload?: string,
  look?: { color?: string; outfit?: string }
): NewBotPicture {
  const t = useTranslate()
  const [choiceKey] = useState(newAvatarDraftKey)
  const [value, setValue] = useState<BotPictureValue>(() =>
    initialUpload ? { kind: 'custom' } : firstMascot(mascot)
  )
  const [picked, setColor] = useState<string | null>(look?.color ?? null)
  const color = host.colors ? picked : null
  const [pickedOutfit, setOutfit] = useState<string | null>(look?.outfit ?? null)
  const outfit = host.outfits ? wornBotOutfit(pickedOutfit) : null
  const [upload, setUpload] = useState<NewBotUpload | null>(() =>
    initialUpload ? { png: initialUpload, after: -1 } : null
  )
  const custom = upload && {
    src: `data:image/png;base64,${upload.png}`,
    fallback: '',
    after: upload.after,
    description:
      generatedPictureDescription(upload.png) ?? t('bots.new.pictureUpload', 'Your image')
  }
  const showingUpload = value.kind === 'custom' && upload !== null
  const mascotId =
    PICKABLE_BOT_MASCOT_IDS[pictureMascotIndex(value, custom)] ?? PICKABLE_BOT_MASCOT_IDS[0]
  const mascotLook = useBotMascotLook(mascotId, color, outfit, 'large')
  return {
    value,
    custom,
    onChange: (next) => {
      noteBotPictureChoice(choiceKey)
      setValue(next)
    },
    onUpload: (png, after) => {
      setUpload({ png, after })
      setValue({ kind: 'custom' })
    },
    placeUpload: (png) => {
      setUpload({
        png,
        after: showingUpload && upload ? upload.after : pictureMascotIndex(value, custom)
      })
      setValue({ kind: 'custom' })
    },
    color,
    onColorChange: host.colors
      ? (next) => {
          noteBotPictureChoice(choiceKey)
          setColor(next)
        }
      : undefined,
    outfit,
    onOutfitChange: host.outfits
      ? (next) => {
          noteBotPictureChoice(choiceKey)
          setOutfit(next)
        }
      : undefined,
    src: showingUpload && custom ? custom.src : mascotLook.src,
    outfitArt: showingUpload ? null : mascotLook.outfit,
    avatar: mascotAvatar(mascotId),
    avatarColor: showingUpload || !color ? undefined : color,
    avatarOutfit: showingUpload || !host.outfits || !pickedOutfit ? undefined : pickedOutfit,
    shownUpload: showingUpload ? upload.png : null,
    saveUpload: async (bot) =>
      showingUpload
        ? // Settings can try again if the upload is refused.
          uploadBotAvatar(bot, upload.png).then(
            (saved) => {
              keepSavedPictureDescription(saved, upload.png)
              return saved
            },
            (error: unknown) => {
              toast.error(botErrorMessage(error))
              return bot
            }
          )
        : bot,
    reset: () => {
      setColor(look?.color ?? null)
      setOutfit(look?.outfit ?? null)
      setValue(initialUpload ? { kind: 'custom' } : firstMascot(mascot))
      setUpload(initialUpload ? { png: initialUpload, after: -1 } : null)
    },
    choiceKey
  }
}
