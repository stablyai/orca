// A mascot's tile color: one of the picker's swatches, or any color the owner picks.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

/** The mascots' own sky blue, shown when a bot has no color. */
export const DEFAULT_BOT_AVATAR_COLOR = '#b3dbf4'

/** The picker's swatches, the default first. */
export const BOT_AVATAR_COLORS = [
  DEFAULT_BOT_AVATAR_COLOR,
  '#ffffff',
  '#c9b8e8',
  '#f4c4cf',
  '#f8cfa8',
  '#f6e3a1',
  '#c5dfb5',
  '#b5e3d8',
  '#8fa3b8',
  '#3a3f4b',
  '#1f2126'
] as const

export const BotAvatarColorSchema = lazyZodSchema(() => z.string().regex(/^#[0-9a-f]{6}$/))

function channel(hex: string): number {
  const c = Number.parseInt(hex, 16) / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Dark enough that a dark mascot would sink into it, so the mascot gets a light rim. */
export function isDarkBotAvatarColor(color: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => channel(color.slice(i, i + 2)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.18
}
