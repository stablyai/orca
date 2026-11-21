// An uploaded picture, cropped square from its center and scaled to Slack's 512 px. DOM only: the desktop's
// renderer and the phone's page draw it on a canvas.
import { BOT_AVATAR_SIZE, MIN_BOT_AVATAR_SOURCE_SIDE } from '../bot-avatar'

export const BOT_AVATAR_TOO_SMALL = 'bot_avatar_too_small'

/** The picture drawn on a new 512 px canvas; throws BOT_AVATAR_TOO_SMALL under 128 px on its short side. */
export function drawSquareBotAvatar(
  source: CanvasImageSource,
  width: number,
  height: number
): CanvasRenderingContext2D {
  const side = Math.min(width, height)
  if (side < MIN_BOT_AVATAR_SOURCE_SIDE) {
    throw new Error(BOT_AVATAR_TOO_SMALL)
  }
  const canvas = document.createElement('canvas')
  canvas.width = BOT_AVATAR_SIZE
  canvas.height = BOT_AVATAR_SIZE
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('bot_avatar_invalid')
  }
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    source,
    (width - side) / 2,
    (height - side) / 2,
    side,
    side,
    0,
    0,
    BOT_AVATAR_SIZE,
    BOT_AVATAR_SIZE
  )
  return context
}
