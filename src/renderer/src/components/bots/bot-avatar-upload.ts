// An uploaded picture, cropped square from its center and scaled to Slack's 512 px, as base64 PNG.
import { BOT_AVATAR_SIZE, MIN_BOT_AVATAR_SOURCE_SIDE } from '../../../../shared/bot-avatar'

export const BOT_AVATAR_TOO_SMALL = 'bot_avatar_too_small'

export async function squareAvatarPng(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
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
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      BOT_AVATAR_SIZE,
      BOT_AVATAR_SIZE
    )
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('bot_avatar_invalid'))),
        'image/png'
      )
    )
    const bytes = new Uint8Array(await png.arrayBuffer())
    let binary = ''
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
  } finally {
    bitmap.close()
  }
}
