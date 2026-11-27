/** Markdown pictures inside a native chat message. Comment images and attachment tiles do not use this. */

export const NATIVE_CHAT_MARKDOWN_IMAGE_SIZES = ['compact', 'medium', 'column'] as const

export type NativeChatMarkdownImageSize = (typeof NATIVE_CHAT_MARKDOWN_IMAGE_SIZES)[number]

/** Absent or unknown means column width, the same default a new profile stores. */
export function normalizeNativeChatMarkdownImageSize(value: unknown): NativeChatMarkdownImageSize {
  return value === 'compact' || value === 'medium' || value === 'column' ? value : 'column'
}

const DESKTOP_OUTLINE = 'rounded-md object-contain outline outline-1 outline-border/70'

/** Desktop caps. Medium is the previous 384px-tall picture. Compact is 160px tall and 240px wide. */
const DESKTOP_CLASS_BY_SIZE: Record<NativeChatMarkdownImageSize, string> = {
  compact: `max-h-40 max-w-60 ${DESKTOP_OUTLINE}`,
  medium: `max-h-96 max-w-full ${DESKTOP_OUTLINE}`,
  column: `h-auto w-full ${DESKTOP_OUTLINE}`
}

export function nativeChatMarkdownImageClassName(value: unknown): string {
  return DESKTOP_CLASS_BY_SIZE[normalizeNativeChatMarkdownImageSize(value)]
}

export type NativeChatMarkdownImageFrame = {
  width: number | '100%'
  height?: number
  aspectRatio?: number
  maxWidth?: '100%'
  alignSelf?: 'flex-start'
}

const PHONE_COMPACT = { maxWidth: 200, maxHeight: 150 }
const PHONE_MEDIUM = { maxWidth: 280, maxHeight: 210 }

/**
 * Phone frame. Compact is today's 200 by 150 thumb. Medium sits between that and the column.
 * Column width fills the message. The frame hugs the picture; it does not crop it.
 */
export function nativeChatMarkdownImageFrame(
  value: unknown,
  aspect: number | null
): NativeChatMarkdownImageFrame {
  const size = normalizeNativeChatMarkdownImageSize(value)
  const ratio = typeof aspect === 'number' && Number.isFinite(aspect) && aspect > 0 ? aspect : 3 / 2
  if (size === 'column') {
    return { width: '100%', aspectRatio: ratio }
  }
  const cap = size === 'compact' ? PHONE_COMPACT : PHONE_MEDIUM
  let width = cap.maxWidth
  let height = width / ratio
  if (height > cap.maxHeight) {
    height = cap.maxHeight
    width = height * ratio
  }
  return { width, height, maxWidth: '100%', alignSelf: 'flex-start' }
}
