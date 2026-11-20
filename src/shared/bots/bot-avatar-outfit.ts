// What a mascot wears: drawn over its picture, placed per mascot.
import * as z from 'zod'

/** In the picker's order; ids are never renamed, since bots store them. */
export const BOT_AVATAR_OUTFITS = [
  'tie',
  'detective',
  'hard-hat',
  'reviewer',
  'night-shift',
  'artist',
  'scientist',
  'party'
] as const

export type BotAvatarOutfit = (typeof BOT_AVATAR_OUTFITS)[number]

export const BotAvatarOutfitSchema = z.enum(BOT_AVATAR_OUTFITS)
