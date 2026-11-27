// A mascot's look drawn once as the 512 px PNG its bot's Slack app shows: the mascot's SVG on its tile
// color, then its outfit's large art over it where the picture places it, as the big in-app picture draws.
import { encodeBase64Bytes } from '@/lib/base64-bytes'
import { BOT_AVATAR_SIZE, type BotMascotId } from '../../../../shared/bot-avatar'
import { DEFAULT_BOT_AVATAR_COLOR } from '../../../../shared/bots/bot-avatar-color'
import type { BotAvatarOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { readBotMascotSvg } from './bot-mascot-look'
import { readBotOutfitArt } from './bot-outfit-art'

const TILE = 128

// The mascots carry only a viewBox; a canvas would draw them at the default 300 by 150 without a size.
function sized(svg: string): string {
  return svg.replace('<svg ', `<svg width="${BOT_AVATAR_SIZE}" height="${BOT_AVATAR_SIZE}" `)
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image(BOT_AVATAR_SIZE, BOT_AVATAR_SIZE)
  image.src = src
  await image.decode()
  return image
}

/** Base64 PNG of the look; null when its art can't be read (a failed outfit read is tried on the next look). */
export async function drawBotSlackIcon(
  id: BotMascotId,
  color: string | null,
  outfit: BotAvatarOutfit | null
): Promise<string | null> {
  const art = outfit ? await readBotOutfitArt(outfit) : null
  if (art === undefined) {
    return null
  }
  const layer = art?.layers[id]
  const large = art?.large[id]
  const tile = color && color !== DEFAULT_BOT_AVATAR_COLOR ? color : null
  // Without its large art the outfit is left off, as the in-app picture leaves it off until it arrives.
  const svg = await readBotMascotSvg(id, tile, large ? layer : undefined)
  if (!svg) {
    return null
  }
  const [mascot, worn] = await Promise.all([
    loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized(svg))}`),
    layer && large ? loadImage(`data:image/webp;base64,${large.art}`) : null
  ])
  const canvas = document.createElement('canvas')
  canvas.width = BOT_AVATAR_SIZE
  canvas.height = BOT_AVATAR_SIZE
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }
  context.imageSmoothingQuality = 'high'
  context.drawImage(mascot, 0, 0, BOT_AVATAR_SIZE, BOT_AVATAR_SIZE)
  if (worn && layer) {
    const [x, y, width, height] = layer.at.map((v) => (v / TILE) * BOT_AVATAR_SIZE)
    context.drawImage(worn, x, y, width, height)
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) {
    return null
  }
  return encodeBase64Bytes(new Uint8Array(await blob.arrayBuffer()))
}
