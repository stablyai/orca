// The bot settings picture's choices compared by value, and the save loop's state; see
// use-bot-picture-setting.ts.
import type { BotPictureValue } from '@/components/bots/BotPicturePicker'
import {
  mascotAvatar,
  parseBotAvatar,
  PICKABLE_BOT_MASCOT_IDS
} from '../../../../../shared/bot-avatar'

export const BOT_PICTURE_SAVE_DELAY_MS = 500

export const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

/**
 * The bot's own picture when it is not a mascot, kept while Settings is open so stepping back
 * restores it. `avatar` is the saved value (null until a new upload is confirmed); `png` re-sends an upload.
 */
export type KeptPicture = {
  id: number
  avatar: string | null
  png: string | null
  after: number
  /** For an upload not yet confirmed: the kept picture it replaced, back if it is refused. */
  replaced?: KeptPicture | null
}

/** A choice compared by value: the mascot's avatar, or which kept picture. */
export type PictureKey = string

export function choiceKey(choice: BotPictureValue, kept: KeptPicture | null): PictureKey {
  return choice.kind === 'mascot'
    ? mascotAvatar(PICKABLE_BOT_MASCOT_IDS[choice.index] ?? PICKABLE_BOT_MASCOT_IDS[0])
    : `custom:${kept?.id ?? -1}`
}

// The carousel's place of a mascot it offers; -1 for anything else, a retired mascot included.
function pickableIndex(avatar: string | null): number {
  const parsed = parseBotAvatar(avatar)
  return parsed?.kind === 'mascot' ? PICKABLE_BOT_MASCOT_IDS.indexOf(parsed.id) : -1
}

export function savedChoice(avatar: string | null): BotPictureValue {
  const index = pickableIndex(avatar)
  return index >= 0 ? { kind: 'mascot', index } : { kind: 'custom' }
}

// A picture the carousel doesn't offer (an upload, an emoji, a retired mascot) is kept as the bot's own.
export function keptFrom(avatar: string | null, id: number, after: number): KeptPicture | null {
  return pickableIndex(avatar) >= 0 ? null : { id, avatar, png: null, after }
}

export type SaveLoop = {
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
  /** Send the desired choice even if it is the saved one: a generated picture's upload may land first. */
  force: boolean
  /** Undos and uploads still reading the picture they put back or replace. */
  waits: number
  /** Kept pictures are never renumbered, so a refused upload's id is not reused. */
  nextKeptId: number
  timer: ReturnType<typeof setTimeout> | null
}
