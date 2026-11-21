export const DEFAULT_NATIVE_CHAT_FONT_WEIGHT = 400
export const NATIVE_CHAT_FONT_WEIGHTS = [300, DEFAULT_NATIVE_CHAT_FONT_WEIGHT, 500] as const
export type NativeChatFontWeight = (typeof NATIVE_CHAT_FONT_WEIGHTS)[number]

export function normalizeNativeChatFontWeight(value: unknown): NativeChatFontWeight {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_NATIVE_CHAT_FONT_WEIGHT
  }
  return value < 350 ? 300 : value >= 450 ? 500 : DEFAULT_NATIVE_CHAT_FONT_WEIGHT
}
