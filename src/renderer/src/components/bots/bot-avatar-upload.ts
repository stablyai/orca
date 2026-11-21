// An uploaded picture, cropped square from its center and scaled to Slack's 512 px, as base64 PNG.
import { BOT_AVATAR_SIZE } from '../../../../shared/bot-avatar'
import { drawSquareBotAvatar } from '../../../../shared/bots/bot-avatar-square'
import { pictureTint, rememberPictureTint } from './avatar-picture-tint'

export async function squareAvatarPng(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const context = drawSquareBotAvatar(bitmap, bitmap.width, bitmap.height)
    // Read once here, where the pixels are at hand, so nothing reads the picture again to tint by it.
    const tint = pictureTint(
      context.getImageData(0, 0, BOT_AVATAR_SIZE, BOT_AVATAR_SIZE).data,
      BOT_AVATAR_SIZE
    )
    const png = await new Promise<Blob>((resolve, reject) =>
      context.canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('bot_avatar_invalid'))),
        'image/png'
      )
    )
    const bytes = new Uint8Array(await png.arrayBuffer())
    let binary = ''
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    const base64 = btoa(binary)
    rememberPictureTint(base64, tint)
    return base64
  } finally {
    bitmap.close()
  }
}
