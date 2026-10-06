import { HEX_COLOR_RE } from './color-validation'

export type NativeChatAppearanceSettings = {
  /** Chat text size in px, 12–20; absent = 14. */
  fontSize?: number
  /** Code text size in px, 10–18; absent = 12. */
  codeFontSize?: number
  /** Transcript and composer width; absent = comfortable (46rem). */
  width?: 'comfortable' | 'wide' | 'full'
  /** Chat text color in the light theme, as typed (hex when valid); absent = theme default. */
  textColorLight?: string
  /** Chat text color in the dark theme, as typed (hex when valid); absent = theme default. */
  textColorDark?: string
  /** Your message bubble color in the light theme, as typed (hex when valid); absent = theme default. */
  userBubbleColorLight?: string
  /** Your message bubble color in the dark theme, as typed (hex when valid); absent = theme default. */
  userBubbleColorDark?: string
}

export const NATIVE_CHAT_COLOR_KEYS = [
  'textColorLight',
  'textColorDark',
  'userBubbleColorLight',
  'userBubbleColorDark'
] as const
export type NativeChatColorKey = (typeof NATIVE_CHAT_COLOR_KEYS)[number]

export type ResolvedNativeChatAppearanceSettings = Required<
  Pick<NativeChatAppearanceSettings, 'fontSize' | 'codeFontSize' | 'width'>
> &
  Record<NativeChatColorKey, string | undefined>

export type NativeChatGlobalSettings = {
  nativeChatAppearance?: NativeChatAppearanceSettings
}

export const DEFAULT_NATIVE_CHAT_FONT_SIZE = 14
export const DEFAULT_NATIVE_CHAT_CODE_FONT_SIZE = 12

const KNOWN_KEYS: readonly string[] = [
  'fontSize',
  'codeFontSize',
  'width',
  ...NATIVE_CHAT_COLOR_KEYS
]

// Why: kept as typed so a half-entered hex survives the next write; validated where it is applied.
function normalizeColorDraft(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim().slice(0, 32) : ''
  return trimmed || undefined
}

function resolveColor(value: string | undefined): string | undefined {
  if (!value || !HEX_COLOR_RE.test(value)) {
    return undefined
  }
  return value.startsWith('#') ? value : `#${value}`
}

function normalizeSize(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback
}

export function normalizeNativeChatAppearanceSettings(
  value: unknown
): NativeChatAppearanceSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const fontSize = normalizeSize('fontSize' in value ? value.fontSize : undefined, 12, 20, 14)
  const codeFontSize = normalizeSize(
    'codeFontSize' in value ? value.codeFontSize : undefined,
    10,
    18,
    12
  )
  const width =
    'width' in value && (value.width === 'wide' || value.width === 'full') ? value.width : undefined
  const colors = Object.fromEntries(
    NATIVE_CHAT_COLOR_KEYS.flatMap((key) => {
      const color = normalizeColorDraft(Object.getOwnPropertyDescriptor(value, key)?.value)
      return color ? [[key, color]] : []
    })
  )
  const normalized: NativeChatAppearanceSettings = {
    ...Object.fromEntries(Object.entries(value).filter(([key]) => !KNOWN_KEYS.includes(key))),
    ...(fontSize !== DEFAULT_NATIVE_CHAT_FONT_SIZE ? { fontSize } : {}),
    ...(codeFontSize !== DEFAULT_NATIVE_CHAT_CODE_FONT_SIZE ? { codeFontSize } : {}),
    ...(width ? { width } : {}),
    ...colors
  }
  return Object.keys(normalized).length ? normalized : undefined
}

export function resolveNativeChatAppearanceSettings(
  value: unknown
): ResolvedNativeChatAppearanceSettings {
  const normalized = normalizeNativeChatAppearanceSettings(value)
  return {
    fontSize: normalized?.fontSize ?? DEFAULT_NATIVE_CHAT_FONT_SIZE,
    codeFontSize: normalized?.codeFontSize ?? DEFAULT_NATIVE_CHAT_CODE_FONT_SIZE,
    width: normalized?.width ?? 'comfortable',
    textColorLight: resolveColor(normalized?.textColorLight),
    textColorDark: resolveColor(normalized?.textColorDark),
    userBubbleColorLight: resolveColor(normalized?.userBubbleColorLight),
    userBubbleColorDark: resolveColor(normalized?.userBubbleColorDark)
  }
}

export function resetNativeChatAppearanceSettings(
  appearance: NativeChatAppearanceSettings | undefined
): NativeChatAppearanceSettings | undefined {
  return normalizeNativeChatAppearanceSettings(
    Object.fromEntries(
      Object.entries(appearance ?? {}).filter(([key]) => !KNOWN_KEYS.includes(key))
    )
  )
}
