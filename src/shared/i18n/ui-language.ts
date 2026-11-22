export const UI_LANGUAGE_SYSTEM = 'system'
export const UI_LANGUAGE_ENGLISH = 'en'
export const UI_LANGUAGE_CHINESE = 'zh'
// Why: a script subtag, not a region — zh-Hant also serves zh-TW/zh-HK/zh-MO users.
export const UI_LANGUAGE_CHINESE_TRADITIONAL = 'zh-Hant'
export const UI_LANGUAGE_KOREAN = 'ko'
export const UI_LANGUAGE_JAPANESE = 'ja'
export const UI_LANGUAGE_SPANISH = 'es'
export const UI_LANGUAGE_FRENCH = 'fr'
export const UI_LANGUAGE_PORTUGUESE = 'pt'
export const UI_LANGUAGE_RUSSIAN = 'ru'
export const UI_LANGUAGE_TURKISH = 'tr'
export const UI_LANGUAGE_GERMAN = 'de'

export type BuiltInUiLanguage =
  | typeof UI_LANGUAGE_SYSTEM
  | typeof UI_LANGUAGE_ENGLISH
  | typeof UI_LANGUAGE_CHINESE
  | typeof UI_LANGUAGE_CHINESE_TRADITIONAL
  | typeof UI_LANGUAGE_KOREAN
  | typeof UI_LANGUAGE_JAPANESE
  | typeof UI_LANGUAGE_SPANISH
  | typeof UI_LANGUAGE_FRENCH
  | typeof UI_LANGUAGE_PORTUGUESE
  | typeof UI_LANGUAGE_RUSSIAN
  | typeof UI_LANGUAGE_TURKISH
  | typeof UI_LANGUAGE_GERMAN

export type PluginUiLanguage = `plugin:${string}`
export type UiLanguage = BuiltInUiLanguage | PluginUiLanguage

// Each language in its own script, so someone stuck in a language they cannot read can find theirs.
export const UI_LANGUAGE_NATIVE_NAMES: Record<BuiltInUiLanguage, string> = {
  [UI_LANGUAGE_SYSTEM]: 'System',
  [UI_LANGUAGE_ENGLISH]: 'English',
  [UI_LANGUAGE_CHINESE]: '中文（简体）',
  [UI_LANGUAGE_CHINESE_TRADITIONAL]: '繁體中文（台灣）',
  [UI_LANGUAGE_KOREAN]: '한국어',
  [UI_LANGUAGE_JAPANESE]: '日本語',
  [UI_LANGUAGE_SPANISH]: 'Español',
  [UI_LANGUAGE_FRENCH]: 'Français',
  [UI_LANGUAGE_PORTUGUESE]: 'Português (Brasil)',
  [UI_LANGUAGE_RUSSIAN]: 'Русский',
  [UI_LANGUAGE_TURKISH]: 'Türkçe',
  [UI_LANGUAGE_GERMAN]: 'Deutsch'
}

const UI_LANGUAGE_VALUES = new Set<BuiltInUiLanguage>([
  UI_LANGUAGE_SYSTEM,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_CHINESE_TRADITIONAL,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_SPANISH,
  UI_LANGUAGE_FRENCH,
  UI_LANGUAGE_PORTUGUESE,
  UI_LANGUAGE_RUSSIAN,
  UI_LANGUAGE_TURKISH,
  UI_LANGUAGE_GERMAN
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
