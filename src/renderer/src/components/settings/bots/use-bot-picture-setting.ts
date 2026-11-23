// The bot settings picture: a step shows at once; one save at a time follows the latest choice.
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { BotPictureCustom, BotPictureValue } from '@/components/bots/BotPicturePicker'
import { useBotAvatarLook } from '@/components/bots/bot-avatar-image'
import { botFallback } from '../../../../../shared/bots/bot-avatar-fallback'
import { useTranslate } from '@/i18n/use-translate'
import { readBotAvatarPng, readHostBots } from '@/lib/bot-catalog'
import { botRefKey } from '@/lib/bot-hosts'
import {
  automaticBotPictureUploadInFlight,
  beginBotPictureOp,
  noteBotPictureChoice,
  subscribeBotPictureEvents
} from '@/components/bots/bot-picture-ops'
import {
  generatedPictureDescription,
  useSavedPictureDescription
} from '@/components/bots/generated-avatar-descriptions'
import { isUploadAvatar, parseBotAvatar } from '../../../../../shared/bot-avatar'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import type { BotAvatarOutfit } from '../../../../../shared/bots/bot-avatar-outfit'
import { useBotPictureLook } from './use-bot-picture-look'
import { useSaveOnClose } from './use-save-on-close'
import { sendBotPicture } from './bot-picture-setting-send'
import {
  BOT_PICTURE_SAVE_DELAY_MS,
  choiceKey,
  keptFrom,
  PNG_DATA_URL_PREFIX,
  savedChoice,
  type KeptPicture,
  type SaveLoop
} from './bot-picture-setting-choices'

export { BOT_PICTURE_SAVE_DELAY_MS }

export function useBotPictureSetting(
  bot: Bot,
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
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
  /** A picture starts being taken in (a paste, drop or file): a choice from now. The returned call
   *  runs once it is read, whichever way. */
  beginIntake: () => () => void
  /** How many pictures were uploaded so far (taken in, or a generated one picked), for telling
   *  whether one came after a moment. */
  uploads: () => number
} {
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
    force: false,
    waits: 0,
    nextKeptId: 1,
    timer: null
  })
  const live = loop.current
  const key = botRefKey(bot)
  // While anything here is still to save, the ledger has it open, so a picture asked for now waits
  // for its revision.
  const op = useRef<{ end: () => void } | null>(null)
  const syncOp = (): void => {
    const busy = live.saving || live.timer !== null || live.desired !== live.saved || live.waits > 0
    if (busy && !op.current) {
      op.current = beginBotPictureOp(key)
    } else if (!busy && op.current) {
      const ended = op.current
      op.current = null
      ended.end()
    }
  }
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

  const send = (choice: BotPictureValue): Promise<boolean> =>
    sendBotPicture(choice, { bot, live, update, setKept })

  // One save in flight; when it lands, the latest choice is saved if it differs.
  const kick = (): void => {
    if (live.saving || (live.desired === live.saved && !live.force)) {
      syncOp()
      return
    }
    live.force = false
    const desired = live.desired
    const choice = live.desiredChoice
    live.saving = true
    syncOp()
    void send(choice).then((ok) => {
      live.saving = false
      if (ok) {
        live.saved = desired
        live.savedChoice = choice
      } else if (live.desired === desired) {
        // Refused: back to what is saved, unless the owner has moved on.
        live.desired = live.saved
        live.desiredChoice = live.savedChoice
        show(live.savedChoice)
      }
      kick()
      // A picture set elsewhere while this save was in flight shows now, whichever way it went.
      reconcile()
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
    noteBotPictureChoice(key)
    show(choice)
    if (live.timer) {
      clearTimeout(live.timer)
    }
    // Even the saved picture is sent: a generated one being uploaded may land first, and this is newer.
    if (automaticBotPictureUploadInFlight(key)) {
      live.force = true
    }
    live.timer = setTimeout(commit, BOT_PICTURE_SAVE_DELAY_MS)
    syncOp()
  }

  // What the last upload replaced; its PNG is held because the upload overwrites the file.
  const beforeUpload = useRef<{
    kept: KeptPicture | null
    shown: BotPictureValue
    png: Promise<string | null>
  } | null>(null)

  const uploads = useRef(0)
  const upload = (png: string, after: number): void => {
    nextChoice()
    uploads.current += 1
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
      live.waits += 1
      syncOp()
      void previousPng.then(() => {
        live.waits -= 1
        commit()
      })
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
    noteBotPictureChoice(key)
    live.waits += 1
    syncOp()
    void before.png.then((png) => {
      live.waits -= 1
      if (choiceGeneration.current !== generation) {
        syncOp()
        return
      }
      const kept = before.kept && {
        ...before.kept,
        png: before.kept.png ?? png,
        replaced: undefined
      }
      // An upload whose bytes could not be read can't be put back.
      if (kept && isUploadAvatar(kept.avatar) && !kept.png) {
        syncOp()
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

  // A look is for the picture shown. A generated one still uploading may land first, so the picture
  // shown is sent again with it.
  const look = useBotPictureLook(bot, update, () => {
    if (automaticBotPictureUploadInFlight(key)) {
      pick(live.shown)
    }
  })

  useSaveOnClose(() => {
    commit()
    look.flush()
  })

  // A picture set elsewhere (the CLI, another window, a generated picture) is adopted while nothing is
  // pending here.
  const adopt = (avatar: string | null): void => {
    if (live.saving || live.timer || live.desired !== live.saved || live.waits > 0) {
      return
    }
    const savedAvatar = live.savedChoice.kind === 'mascot' ? live.saved : live.kept?.avatar
    if (avatar === savedAvatar) {
      return
    }
    nextChoice()
    const choice = savedChoice(avatar)
    if (choice.kind === 'custom') {
      setKept(keptFrom(avatar, live.nextKeptId++, live.kept?.after ?? -1))
    }
    show(choice)
    live.saved = live.desired = choiceKey(choice, live.kept)
    live.savedChoice = live.desiredChoice = choice
  }
  // The catalog's picture now, which a save refreshes before it resolves, so it can be ahead of the bot
  // this hook was last rendered with. Nothing to compare when the catalog doesn't list the bot.
  const reconcile = (): void => {
    const current = readHostBots(bot.hostId).find((entry) => entry.id === bot.id)
    if (current) {
      adopt(current.avatar)
    }
  }
  useEffect(() => {
    adopt(bot.avatar)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the loop state is read through its ref
  }, [bot.avatar])
  const onAutomaticSettled = useEffectEvent(() => {
    // A pick still waiting is sent, even of the saved picture: it came after the generated one.
    if (live.timer || live.saving) {
      live.force = true
    }
    reconcile()
  })
  useEffect(
    () =>
      subscribeBotPictureEvents((event) => {
        if (event.kind === 'automatic-settled' && event.key === key) {
          onAutomaticSettled()
        }
      }),
    [key]
  )
  // Unmounting leaves the op open: the save on close is still in flight, and ends it as it settles.

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
    color: look.color,
    pickColor: look.pickColor,
    outfit: look.outfit,
    pickOutfit: look.pickOutfit,
    beginIntake: () => {
      noteBotPictureChoice(key)
      return beginBotPictureOp(key).end
    },
    uploads: () => uploads.current
  }
}
