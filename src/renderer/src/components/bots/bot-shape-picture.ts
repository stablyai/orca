// The opt-in shape picture: the `mug` preset bundled with open-bot-avatar (MIT, Dominik Scholz).
import { getExample, renderAvatarSvg } from 'open-bot-avatar'
import {
  BotAvatarColorSchema,
  DEFAULT_BOT_AVATAR_COLOR
} from '../../../../shared/bots/bot-avatar-color'

// Null if a package upgrade drops the preset: the bot then shows its initial instead of failing to render.
export const BOT_SHAPE = getExample('mug') ?? null

export function botShapeColor(color: string | null | undefined): string {
  const parsed = BotAvatarColorSchema.safeParse(color)
  return parsed.success ? parsed.data : DEFAULT_BOT_AVATAR_COLOR
}

/** The shape's still picture as a data URL, or null without the preset. */
export function botShapePicture(color: string | null | undefined): string | null {
  if (!BOT_SHAPE) {
    return null
  }
  const svg = renderAvatarSvg(BOT_SHAPE, {
    color: botShapeColor(color),
    state: 'idle',
    reducedMotion: true
  })
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
