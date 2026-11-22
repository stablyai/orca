// Every way a picture comes in (file chooser, paste, drop) ends as one Blob cropped to a 512 px PNG.
import { BOT_AVATAR_SOURCE_TYPES, MAX_BOT_AVATAR_SOURCE_BYTES } from '../../../../shared/bot-avatar'
import { BOT_AVATAR_TOO_SMALL } from '../../../../shared/bots/bot-avatar-square'
import { bestIcnsPng, hasIcnsMagic, isIcnsFileName, isIcnsMimeType } from './bot-avatar-icns'
import { squareAvatarPng } from './bot-avatar-upload'

/** Why a pasted or dropped picture was not used. */
export type BotAvatarIntakeError = 'too_big' | 'type' | 'too_small'

export class BotAvatarIntakeFailure extends Error {
  constructor(readonly error: BotAvatarIntakeError) {
    super(`bot_avatar_${error}`)
  }
}

/** The file chooser offers what the intake reads. */
export const BOT_AVATAR_ACCEPT = [...BOT_AVATAR_SOURCE_TYPES, '.icns'].join(',')

/** Image data is the picture; any other paste (a link, text) is left alone. */
export function pastedAvatarSource(data: DataTransfer | null): Blob | null {
  return Array.from(data?.files ?? []).find((file) => file.type.startsWith('image/')) ?? null
}

/** Whether a drag carries files; a link-only drag is not a picture. */
export function isAvatarDrag(types: readonly string[] | null | undefined): boolean {
  return types?.includes('Files') === true
}

/** A dropped file, refused later if it isn't an image. */
export function droppedAvatarSource(data: DataTransfer | null): Blob | null {
  const files = Array.from(data?.files ?? [])
  return files.find((entry) => entry.type.startsWith('image/')) ?? files[0] ?? null
}

/** A square 512 px PNG (base64) from any image Blob, or a failure naming why not. */
export async function avatarPngFromBlob(blob: Blob): Promise<string> {
  if (blob.size > MAX_BOT_AVATAR_SOURCE_BYTES) {
    throw new BotAvatarIntakeFailure('too_big')
  }
  try {
    const name = 'name' in blob && typeof blob.name === 'string' ? blob.name : ''
    const claimedIcns = isIcnsMimeType(blob.type) || isIcnsFileName(name)
    if (claimedIcns || blob.type === 'application/octet-stream' || (!blob.type && !name)) {
      const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
      if (hasIcnsMagic(header) || claimedIcns) {
        const png = bestIcnsPng(new Uint8Array(await blob.arrayBuffer()))
        if (!png) {
          throw new Error('bot_avatar_invalid')
        }
        const pngBuffer = new ArrayBuffer(png.byteLength)
        new Uint8Array(pngBuffer).set(png)
        return await squareAvatarPng(new Blob([pngBuffer], { type: 'image/png' }))
      }
    }
    if (blob.type && !BOT_AVATAR_SOURCE_TYPES.has(blob.type)) {
      throw new BotAvatarIntakeFailure('type')
    }
    return await squareAvatarPng(blob)
  } catch (error) {
    if (error instanceof BotAvatarIntakeFailure) {
      throw error
    }
    const tooSmall = error instanceof Error && error.message === BOT_AVATAR_TOO_SMALL
    throw new BotAvatarIntakeFailure(tooSmall ? 'too_small' : 'type')
  }
}
