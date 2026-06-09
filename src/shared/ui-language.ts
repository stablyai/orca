export const UI_LANGUAGE_SYSTEM = 'system'
export const UI_LANGUAGE_ENGLISH = 'en'
export const UI_LANGUAGE_CHINESE = 'zh'
export const UI_LANGUAGE_KOREAN = 'ko'
export const UI_LANGUAGE_JAPANESE = 'ja'

export type UiLanguage =
  | typeof UI_LANGUAGE_SYSTEM
  | typeof UI_LANGUAGE_ENGLISH
  | typeof UI_LANGUAGE_CHINESE
  | typeof UI_LANGUAGE_KOREAN
  | typeof UI_LANGUAGE_JAPANESE

const UI_LANGUAGE_VALUES = new Set<UiLanguage>([
  UI_LANGUAGE_SYSTEM,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_JAPANESE
])

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return UI_LANGUAGE_VALUES.has(value as UiLanguage) ? (value as UiLanguage) : UI_LANGUAGE_SYSTEM
}
