// The bot settings picture: a step shows at once; one save at a time follows the latest choice.
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { BotPictureCustom, BotPictureValue } from '@/components/bots/BotPicturePicker'
import { useBotAvatarLook } from '@/components/bots/bot-avatar-image'
import { botErrorMessage } from '@/components/bots/bot-presentation'
import { botFallback } from '../../../../../shared/bots/bot-avatar-fallback'
import { useTranslate } from '@/i18n/use-translate'
import { readBotAvatarPng, uploadBotAvatar } from '@/lib/bot-catalog'
import {
  generatedPictureDescription,
  keepSavedPictureDescription,
  savedPictureDescription,
  useSavedPictureDescription
} from '@/components/bots/generated-avatar-descriptions'
import {
  isUploadAvatar,
  mascotAvatar,
  parseBotAvatar,
  PICKABLE_BOT_MASCOT_IDS
} from '../../../../../shared/bot-avatar'
import { withSlackIconPublish } from '../../bots/use-bot-slack-icons'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { wornBotOutfit, type BotAvatarOutfit } from '../../../../../shared/bots/bot-avatar-outfit'
import { botRefKey } from '@/lib/bot-hosts'
import { beginBotHostUpdate } from '@/lib/bot-host-refresh'
import { useBotLookSave } from './use-bot-look-save'
import { useSaveOnClose } from './use-save-on-close'

export const BOT_PICTURE_SAVE_DELAY_MS = 500

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

/**
 * The bot's own picture when it is not a mascot, kept while Settings is open so stepping back
 * restores it. `avatar` is the saved value (null until a new upload is confirmed); `png` re-sends an upload.
 */
type KeptPicture = {
  id: number
  avatar: string | null
  png: string | null
  after: number
  /** For an upload not yet confirmed: the kept picture it replaced, back if it is refused. */
  replaced?: KeptPicture | null
}

/** A choice compared by value: the mascot's avatar, or which kept picture. */
type PictureKey = string

function choiceKey(choice: BotPictureValue, kept: KeptPicture | null): PictureKey {
  return choice.kind === 'mascot'
    ? mascotAvatar(PICKABLE_BOT_MASCOT_IDS[choice.index] ?? PICKABLE_BOT_MASCOT_IDS[0])
    : `custom:${kept?.id ?? -1}`
}

// The carousel's place of a mascot it offers; -1 for anything else, a retired mascot included.
function pickableIndex(avatar: string | null): number {
  const parsed = parseBotAvatar(avatar)
  return parsed?.kind === 'mascot' ? PICKABLE_BOT_MASCOT_IDS.indexOf(parsed.id) : -1
}

function savedChoice(avatar: string | null): BotPictureValue {
  const index = pickableIndex(avatar)
  return index >= 0 ? { kind: 'mascot', index } : { kind: 'custom' }
}

// A picture the carousel doesn't offer (an upload, an emoji, a retired mascot) is kept as the bot's own.
function keptFrom(avatar: string | null, id: number, after: number): KeptPicture | null {
  return pickableIndex(avatar) >= 0 ? null : { id, avatar, png: null, after }
}

type SaveLoop = {
  kept: KeptPicture | null
  src: string | null
  /** What the carousel shows. */
  shown: BotPictureValue
  /** What should be saved, and what the last save confirmed. */
  desired: PictureKey
  saved: PictureKey
  desiredChoice: BotPictureValue
  savedChoice: BotPictureValue
  saving: boolean
  /** Kept pictures are never renumbered, so a refused upload's id is not reused. */
  nextKeptId: number
  timer: ReturnType<typeof setTimeout> | null
}

export function useBotPictureSetting(
  bot: Bot,
  save: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
): {
  value: BotPictureValue
  custom: BotPictureCustom | null
  pick: (value: BotPictureValue) => void
  upload: (png: string, after: number) => void
  /** Puts back the picture the last upload replaced. */
  undo: () => void
  /** The mascot's tile color shown; null is its own sky blue. */
  color: string | null
  pickColor: (color: string | null) => void
  /** What the mascot wears shown; null is nothing. */
  outfit: BotAvatarOutfit | null
  pickOutfit: (outfit: BotAvatarOutfit | null) => void
} {
  // A saved look is drawn for Slack at once, without waiting for the Bots sidebar.
  const update = withSlackIconPublish(save, bot.hostId)
  const t = useTranslate()
  const [kept, setKeptState] = useState(() => keptFrom(bot.avatar, 0, -1))
  const [shown, setShown] = useState(() => savedChoice(bot.avatar))
  const keptSrc = useBotAvatarLook({
    id: bot.id,
    hostId: bot.hostId,
    avatar: kept?.png ? null : (kept?.avatar ?? null)
  }).src
  const src = kept?.png ? `${PNG_DATA_URL_PREFIX}${kept.png}` : keptSrc
  const savedDescription = useSavedPictureDescription({
    id: bot.id,
    hostId: bot.hostId,
    avatar: kept?.avatar ?? null
  })

  // The save loop reads these between awaits, so they live in a ref.
  const loop = useRef<SaveLoop>({
    kept,
    src,
    shown,
    desired: choiceKey(shown, kept),
    saved: choiceKey(shown, kept),
    savedChoice: shown,
    desiredChoice: shown,
    saving: false,
    nextKeptId: 1,
    timer: null
  })
  const live = loop.current
  useEffect(() => {
    live.src = src
  })
  const setKept = (next: KeptPicture | null): void => {
    live.kept = next
    setKeptState(next)
  }
  const show = (choice: BotPictureValue): void => {
    live.shown = choice
    setShown(choice)
  }

  const send = async (choice: BotPictureValue): Promise<boolean> => {
    if (choice.kind === 'mascot') {
      return (await update({ avatar: choiceKey(choice, null) })) !== null
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
      return !isUploadAvatar(target.avatar) && (await update({ avatar: target.avatar })) !== null
    }
    try {
      // Read before the upload: a picture put back keeps the caption saved with its earlier avatar.
      const known = savedPictureDescription({
        id: bot.id,
        hostId: bot.hostId,
        avatar: target.avatar
      })
      const saved = await uploadBotAvatar(bot, png)
      keepSavedPictureDescription(saved, png, known)
      if (live.kept?.id === target.id) {
        setKept({ ...target, avatar: saved.avatar, replaced: undefined })
      }
      return true
    } catch (error) {
      toast.error(botErrorMessage(error))
      if (live.kept?.id === target.id && target.replaced !== undefined) {
        setKept(target.replaced)
      }
      return false
    }
  }

  // One save in flight; when it lands, the latest choice is saved if it differs.
  const kick = (): void => {
    if (live.saving || live.desired === live.saved) {
      return
    }
    const key = live.desired
    const choice = live.desiredChoice
    live.saving = true
    void send(choice).then((ok) => {
      live.saving = false
      if (ok) {
        live.saved = key
        live.savedChoice = choice
      } else if (live.desired === key) {
        // Refused: back to what is saved, unless the owner has moved on.
        live.desired = live.saved
        live.desiredChoice = live.savedChoice
        show(live.savedChoice)
      }
      kick()
    })
  }

  const commit = (): void => {
    if (live.timer) {
      clearTimeout(live.timer)
      live.timer = null
    }
    live.desired = choiceKey(live.shown, live.kept)
    live.desiredChoice = live.shown
    kick()
  }

  // Bumped by every picture action, so a pending Undo never overrides a later choice.
  const choiceGeneration = useRef(0)
  const nextChoice = (): number => {
    choiceGeneration.current += 1
    return choiceGeneration.current
  }

  const pick = (choice: BotPictureValue): void => {
    nextChoice()
    show(choice)
    if (live.timer) {
      clearTimeout(live.timer)
    }
    live.timer = setTimeout(commit, BOT_PICTURE_SAVE_DELAY_MS)
  }

  // What the last upload replaced; its PNG is held because the upload overwrites the file.
  const beforeUpload = useRef<{
    kept: KeptPicture | null
    shown: BotPictureValue
    png: Promise<string | null>
  } | null>(null)

  const upload = (png: string, after: number): void => {
    nextChoice()
    const previous = live.kept
    const replacesUpload = isUploadAvatar(previous?.avatar ?? null)
    const shownPng = live.src?.startsWith(PNG_DATA_URL_PREFIX)
      ? live.src.slice(PNG_DATA_URL_PREFIX.length)
      : null
    const known = previous?.png ?? (replacesUpload ? shownPng : null)
    // Its bytes may still be loading: read them before the new upload overwrites them.
    const pending = !known && replacesUpload
    const previousPng = pending ? readBotAvatarPng(bot).catch(() => null) : Promise.resolve(known)
    beforeUpload.current = { kept: previous, shown: live.shown, png: previousPng }
    setKept({ id: live.nextKeptId++, avatar: null, png, after, replaced: live.kept })
    show({ kind: 'custom' })
    if (pending) {
      void previousPng.then(commit)
    } else {
      commit()
    }
  }

  const undo = (): void => {
    const before = beforeUpload.current
    beforeUpload.current = null
    if (!before) {
      return
    }
    const generation = nextChoice()
    void before.png.then((png) => {
      if (choiceGeneration.current !== generation) {
        return
      }
      const kept = before.kept && {
        ...before.kept,
        png: before.kept.png ?? png,
        replaced: undefined
      }
      // An upload whose bytes could not be read can't be put back.
      if (kept && isUploadAvatar(kept.avatar) && !kept.png) {
        return
      }
      // A new id, so the loop sees a change and sends the restored picture.
      const id = live.nextKeptId
      live.nextKeptId += 1
      setKept(kept && { ...kept, id })
      show(before.shown)
      commit()
    })
  }

  const hold = () => beginBotHostUpdate(bot.hostId)
  const look = useBotLookSave(botRefKey(bot), update, BOT_PICTURE_SAVE_DELAY_MS, hold, bot)

  useSaveOnClose(() => {
    commit()
    look.flush()
  })

  // A picture set elsewhere (the CLI, another window) is adopted while nothing is pending here.
  useEffect(() => {
    if (live.saving || live.timer || live.desired !== live.saved) {
      return
    }
    const savedAvatar = live.savedChoice.kind === 'mascot' ? live.saved : live.kept?.avatar
    if (bot.avatar === savedAvatar) {
      return
    }
    nextChoice()
    const choice = savedChoice(bot.avatar)
    if (choice.kind === 'custom') {
      setKept(keptFrom(bot.avatar, live.nextKeptId++, live.kept?.after ?? -1))
    }
    show(choice)
    live.saved = live.desired = choiceKey(choice, live.kept)
    live.savedChoice = live.desiredChoice = choice
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the loop state is read through its ref
  }, [bot.avatar])

  // A retired mascot kept as the bot's own picture is still drawn and dressed as that mascot.
  const keptMascot = kept && !kept.png ? parseBotAvatar(kept.avatar) : null
  return {
    value: shown,
    custom: kept && {
      src,
      fallback: botFallback({ name: bot.name, avatar: kept.avatar }),
      after: kept.after,
      ...(keptMascot?.kind === 'mascot' ? { mascot: keptMascot.id } : {}),
      // A generated picture's caption is the description that made it.
      description:
        generatedPictureDescription(kept.png) ??
        savedDescription ??
        (kept.png || isUploadAvatar(kept.avatar)
          ? t('bots.new.pictureUpload', 'Your image')
          : t('settings.bots.pictureCurrent', 'Current picture'))
    },
    pick,
    upload,
    undo,
    color:
      look.picked && 'avatarColor' in look.picked
        ? (look.picked.avatarColor ?? null)
        : (bot.avatarColor ?? null),
    pickColor: (color) => look.pick({ avatarColor: color }),
    outfit:
      look.picked && 'avatarOutfit' in look.picked
        ? wornBotOutfit(look.picked.avatarOutfit)
        : wornBotOutfit(bot.avatarOutfit),
    pickOutfit: (outfit) => look.pick({ avatarOutfit: outfit })
  }
}
