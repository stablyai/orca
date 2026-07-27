export const UI_LANGUAGE_SYSTEM = 'system'
export const UI_LANGUAGE_ENGLISH = 'en'
export const UI_LANGUAGE_CHINESE = 'zh'
export const UI_LANGUAGE_KOREAN = 'ko'
export const UI_LANGUAGE_JAPANESE = 'ja'
export const UI_LANGUAGE_SPANISH = 'es'

export type BuiltInUiLanguage =
  | typeof UI_LANGUAGE_SYSTEM
  | typeof UI_LANGUAGE_ENGLISH
  | typeof UI_LANGUAGE_CHINESE
  | typeof UI_LANGUAGE_KOREAN
  | typeof UI_LANGUAGE_JAPANESE
  | typeof UI_LANGUAGE_SPANISH

export type PluginUiLanguage = `plugin:${string}`
export type UiLanguage = BuiltInUiLanguage | PluginUiLanguage

const UI_LANGUAGE_VALUES = new Set<BuiltInUiLanguage>([
  UI_LANGUAGE_SYSTEM,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_SPANISH
])

const PLUGIN_UI_LANGUAGE_RE =
  /^plugin:[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i

export function isPluginUiLanguage(value: unknown): value is PluginUiLanguage {
  return typeof value === 'string' && PLUGIN_UI_LANGUAGE_RE.test(value)
}

export function normalizeUiLanguage(value: unknown): UiLanguage {
  if (isPluginUiLanguage(value)) {
    return value
  }
  return UI_LANGUAGE_VALUES.has(value as BuiltInUiLanguage)
    ? (value as BuiltInUiLanguage)
    : UI_LANGUAGE_SYSTEM
}
