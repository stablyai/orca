// What a mascot wears: drawn over its picture, placed per mascot.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

/** In the picker's order; ids are never renamed, since bots store them. */
export const BOT_AVATAR_OUTFITS = [
  'tie',
  'detective',
  'hard-hat',
  'reviewer',
  'night-shift',
  'artist',
  'scientist',
  'party',
  'security'
] as const

export type BotAvatarOutfit = (typeof BOT_AVATAR_OUTFITS)[number]

/** A stored outfit: any id, so one a newer version added survives this version's load and save. */
export const BotStoredOutfitSchema = lazyZodSchema(() => z.string().regex(/^[a-z0-9-]{1,40}$/))

/** The outfit to draw for a stored id; one this version doesn't know draws as none. */
export function wornBotOutfit(stored: string | null | undefined): BotAvatarOutfit | null {
  return BOT_AVATAR_OUTFITS.find((outfit) => outfit === stored) ?? null
}
