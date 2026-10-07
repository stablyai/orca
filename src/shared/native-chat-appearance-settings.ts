export type NativeChatAppearanceSettings = {
  /** Chat text size in px, 12–20; absent = 14. */
  fontSize?: number
  /** Code text size in px, 10–18; absent = 12. */
  codeFontSize?: number
  /** Transcript and composer width; absent = comfortable (46rem). */
  width?: 'comfortable' | 'wide' | 'full'
  /** Chat contrast, 50–150; absent = 100. */
  contrast?: number
  /** Follow the terminal interface font and theme; absent = false. */
  matchTerminalInterface?: boolean
}

export type NativeChatGlobalSettings = {
  nativeChatAppearance?: NativeChatAppearanceSettings
  /** Off keeps chats unnamed without running a naming agent. Absent means on. */
  nativeChatAutoName?: boolean
}

export const DEFAULT_NATIVE_CHAT_FONT_SIZE = 14
export const DEFAULT_NATIVE_CHAT_CODE_FONT_SIZE = 12
export const DEFAULT_NATIVE_CHAT_CONTRAST = 100

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
  const contrast = normalizeSize('contrast' in value ? value.contrast : undefined, 50, 150, 100)
  const matchTerminalInterface =
    'matchTerminalInterface' in value && value.matchTerminalInterface === true
  const width =
    'width' in value && (value.width === 'wide' || value.width === 'full') ? value.width : undefined
  const normalized: NativeChatAppearanceSettings = {
    ...Object.fromEntries(
      Object.entries(value).filter(
        ([key]) =>
          !['fontSize', 'codeFontSize', 'width', 'contrast', 'matchTerminalInterface'].includes(key)
      )
    ),
    ...(fontSize !== DEFAULT_NATIVE_CHAT_FONT_SIZE ? { fontSize } : {}),
    ...(codeFontSize !== DEFAULT_NATIVE_CHAT_CODE_FONT_SIZE ? { codeFontSize } : {}),
    ...(width ? { width } : {}),
    ...(contrast !== DEFAULT_NATIVE_CHAT_CONTRAST ? { contrast } : {}),
    ...(matchTerminalInterface ? { matchTerminalInterface } : {})
  }
  return Object.keys(normalized).length ? normalized : undefined
}

export function resolveNativeChatAppearanceSettings(
  value: unknown
): Required<NativeChatAppearanceSettings> {
  const normalized = normalizeNativeChatAppearanceSettings(value)
  return {
    fontSize: normalized?.fontSize ?? DEFAULT_NATIVE_CHAT_FONT_SIZE,
    codeFontSize: normalized?.codeFontSize ?? DEFAULT_NATIVE_CHAT_CODE_FONT_SIZE,
    width: normalized?.width ?? 'comfortable',
    contrast: normalized?.contrast ?? DEFAULT_NATIVE_CHAT_CONTRAST,
    matchTerminalInterface: normalized?.matchTerminalInterface ?? false
  }
}

export function resetNativeChatAppearanceSettings(
  appearance: NativeChatAppearanceSettings | undefined
): NativeChatAppearanceSettings | undefined {
  return normalizeNativeChatAppearanceSettings(
    Object.fromEntries(
      Object.entries(appearance ?? {}).filter(
        ([key]) =>
          !['fontSize', 'codeFontSize', 'width', 'contrast', 'matchTerminalInterface'].includes(key)
      )
    )
  )
}
