// Settings' picture choice and the avatar value it saves, mapped both ways.
import type { BotPictureValue } from '@/components/bots/BotPicturePicker'
import {
  BOT_SHAPE_AVATAR,
  mascotAvatar,
  parseBotAvatar,
  PICKABLE_BOT_MASCOT_IDS
} from '../../../../../shared/bot-avatar'

/** A choice compared by value: the mascot's or the shape's avatar, or which kept picture. */
export type PictureKey = string

export function choiceKey(choice: BotPictureValue, kept: { id: number } | null): PictureKey {
  return choice.kind === 'mascot'
    ? mascotAvatar(PICKABLE_BOT_MASCOT_IDS[choice.index] ?? PICKABLE_BOT_MASCOT_IDS[0])
    : choice.kind === 'shape'
      ? BOT_SHAPE_AVATAR
      : `custom:${kept?.id ?? -1}`
}

// The carousel's place of a mascot it offers; -1 for anything else, a retired mascot included.
function pickableIndex(avatar: string | null): number {
  const parsed = parseBotAvatar(avatar)
  return parsed?.kind === 'mascot' ? PICKABLE_BOT_MASCOT_IDS.indexOf(parsed.id) : -1
}

/** What the carousel shows for a saved avatar; anything it doesn't offer is the bot's own picture. */
export function savedChoice(avatar: string | null): BotPictureValue {
  if (parseBotAvatar(avatar)?.kind === 'shape') {
    return { kind: 'shape' }
  }
  const index = pickableIndex(avatar)
  return index >= 0 ? { kind: 'mascot', index } : { kind: 'custom' }
}
