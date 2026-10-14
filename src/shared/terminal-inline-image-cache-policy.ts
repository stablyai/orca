export const TERMINAL_INLINE_IMAGE_CACHE_MB_DEFAULT = 32
// Why bounds: the addon rejects limits outside 0.5-1000 MB, and each pane keys
// further budgets (Kitty blobs, pending decoders) off the same number.
export const TERMINAL_INLINE_IMAGE_CACHE_MB_MIN = 8
export const TERMINAL_INLINE_IMAGE_CACHE_MB_MAX = 512
export const TERMINAL_INLINE_IMAGE_CACHE_MB_PRESETS = [32, 64, 128, 256, 512] as const

export function normalizeTerminalInlineImageCacheMb(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return TERMINAL_INLINE_IMAGE_CACHE_MB_DEFAULT
  }
  return Math.min(
    TERMINAL_INLINE_IMAGE_CACHE_MB_MAX,
    Math.max(TERMINAL_INLINE_IMAGE_CACHE_MB_MIN, Math.floor(value))
  )
}
