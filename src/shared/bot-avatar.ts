// A bot's picture: one of Orca's mascots, an uploaded image kept in its home, or (from before mascots) an emoji.
import { readPngDimensions } from './file-preview/raster-image-dimensions'

/** The mascots Orca ships, as `mascot:<id>` avatars; ids are never renamed, since bots store them. */
export const BOT_MASCOT_IDS = [
  'A1',
  'B1',
  'D1',
  'E1',
  'F1',
  'G1',
  'H1',
  'H2',
  'I1',
  'J1',
  'K2',
  'L2',
  'M1',
  'N1',
  'O1',
  'P3',
  'Q1',
  'R3',
  'S2',
  'T1'
] as const

export type BotMascotId = (typeof BOT_MASCOT_IDS)[number]

// Retired from the picker; a bot that already has one keeps it.
const RETIRED_BOT_MASCOT_IDS: readonly BotMascotId[] = ['S2']

/** The mascots a new picture is picked from, in carousel order. */
export const PICKABLE_BOT_MASCOT_IDS = BOT_MASCOT_IDS.filter(
  (id) => !RETIRED_BOT_MASCOT_IDS.includes(id)
)

/** An upload, stored as this file in the bot's home. */
export const BOT_AVATAR_FILE = 'avatar.png'
/** Uploads are cropped square to this size: Slack's app icons take 512 to 2000 px. */
export const BOT_AVATAR_SIZE = 512
export const MAX_BOT_AVATAR_SIZE = 2000
export const MAX_BOT_AVATAR_BYTES = 2 * 1024 * 1024

/** A square PNG of 512 to 2000 px and at most 2 MB: what an upload must be. */
export function isBotAvatarImage(png: Uint8Array): boolean {
  const size = readPngDimensions(png)
  return (
    size !== null &&
    size.width === size.height &&
    size.width >= BOT_AVATAR_SIZE &&
    size.width <= MAX_BOT_AVATAR_SIZE &&
    png.byteLength <= MAX_BOT_AVATAR_BYTES
  )
}

/** What a pasted or dropped picture may be before it is cropped: SVG is never read. */
export const BOT_AVATAR_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif'
])
export const MAX_BOT_AVATAR_SOURCE_BYTES = 10 * 1024 * 1024
/** Smaller than this on the short side looks blurry once scaled to 512 px. */
export const MIN_BOT_AVATAR_SOURCE_SIDE = 128

export type ParsedBotAvatar =
  | { kind: 'mascot'; id: BotMascotId }
  | { kind: 'shape' }
  /** `version` names the upload's bytes, so a new one is never shown from an old cache. */
  | { kind: 'upload'; version: string }
  | { kind: 'emoji'; emoji: string }

const MASCOT_PREFIX = 'mascot:'
const UPLOAD_PREFIX = 'upload:'
// Older clients treat an unknown mascot as an initial.
export const BOT_SHAPE_AVATAR = 'mascot:shape-mug'

export function isBotMascotId(value: string): value is BotMascotId {
  return BOT_MASCOT_IDS.some((id) => id === value)
}

export function mascotAvatar(id: BotMascotId): string {
  return `${MASCOT_PREFIX}${id}`
}

export function uploadAvatar(version: string): string {
  return `${UPLOAD_PREFIX}${version}`
}

export function isUploadAvatar(value: string | null): boolean {
  return value?.startsWith(UPLOAD_PREFIX) === true
}

/** Null shows the bot's initial; an unknown mascot id (from a newer Orca) does too. */
export function parseBotAvatar(value: string | null): ParsedBotAvatar | null {
  if (!value) {
    return null
  }
  if (value === BOT_SHAPE_AVATAR) {
    return { kind: 'shape' }
  }
  if (value.startsWith(MASCOT_PREFIX)) {
    const id = value.slice(MASCOT_PREFIX.length)
    return isBotMascotId(id) ? { kind: 'mascot', id } : null
  }
  if (value.startsWith(UPLOAD_PREFIX)) {
    const version = value.slice(UPLOAD_PREFIX.length)
    return version ? { kind: 'upload', version } : null
  }
  return { kind: 'emoji', emoji: value }
}

/** Any mascot but the current one, so a shuffle always changes the picture. */
export function randomMascotAvatar(current: string | null, random = Math.random): string {
  const shown = parseBotAvatar(current)
  const pool = PICKABLE_BOT_MASCOT_IDS.filter(
    (id) => !(shown?.kind === 'mascot' && shown.id === id)
  )
  return mascotAvatar(pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? 'A1')
}

/** What a client may set directly; an upload is set only by sending its image. */
export function isSettableBotAvatar(value: string | null): boolean {
  return !isUploadAvatar(value) && (value === null || parseBotAvatar(value) !== null)
}
