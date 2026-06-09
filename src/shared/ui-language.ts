export const UI_LANGUAGE_SYSTEM = 'system'
export const UI_LANGUAGE_ENGLISH = 'en'

export type UiLanguage = typeof UI_LANGUAGE_SYSTEM | typeof UI_LANGUAGE_ENGLISH

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === UI_LANGUAGE_ENGLISH ? UI_LANGUAGE_ENGLISH : UI_LANGUAGE_SYSTEM
}
