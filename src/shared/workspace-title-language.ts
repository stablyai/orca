import type { GlobalSettings } from './global-settings-types'
import { UI_LANGUAGE_NATIVE_NAMES, isPluginUiLanguage } from './ui-language'
import { SUPPORTED_UI_LOCALES, resolveUiLocale, type SupportedUiLocale } from './ui-locale'

export type WorkspaceTitleLanguage = 'branch' | 'ui' | SupportedUiLocale

export type WorkspaceTitleLanguageSettings = {
  /** Absent follows the branch; localized titles are generated separately from the Git slug. */
  workspaceTitleLanguage?: WorkspaceTitleLanguage
}

export function normalizeWorkspaceTitleLanguage(value: unknown): WorkspaceTitleLanguage {
  if (value === 'ui' || value === 'branch') {
    return value
  }
  return SUPPORTED_UI_LOCALES.find((locale) => locale === value) ?? 'branch'
}

export function shouldAutoRenameWorkspaceTitle(
  settings: Partial<Pick<GlobalSettings, 'autoRenameBranchFromWork' | 'workspaceTitleLanguage'>>
): boolean {
  return (
    settings.autoRenameBranchFromWork === true &&
    normalizeWorkspaceTitleLanguage(settings.workspaceTitleLanguage) !== 'branch'
  )
}

export function resolveWorkspaceTitleLanguage(
  settings: Partial<Pick<GlobalSettings, 'workspaceTitleLanguage' | 'uiLanguage'>>,
  systemLocale: string
): string | undefined {
  const language = normalizeWorkspaceTitleLanguage(settings.workspaceTitleLanguage)
  if (language === 'branch') {
    return undefined
  }
  const locale =
    language === 'ui' ? resolveUiLocale(settings.uiLanguage ?? 'system', systemLocale) : language
  if (isPluginUiLanguage(locale)) {
    return locale.slice(locale.lastIndexOf('/') + 1)
  }
  const supported = SUPPORTED_UI_LOCALES.find((value) => value === locale)
  return supported ? UI_LANGUAGE_NATIVE_NAMES[supported] : locale
}
