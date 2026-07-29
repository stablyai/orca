import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isPluginUiLanguage } from '../../../shared/ui-language'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import { translate } from '@/i18n/i18n'
import { resolveUiLocale } from '@/i18n/supported-languages'
import {
  dismissMacosTccPromptNotice,
  subscribeToMacosTccPromptNotice
} from './macos-tcc-prompt-notice-subscription'

/**
 * Shows the Full Disk Access hint only after macOS has repeatedly raised its
 * consent dialog naming Orca (#9756). The main process counts the dialogs, so
 * users who never see one never see this.
 */
export function useMacosTccPromptNotice(): void {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const uiLanguage = useAppStore((s) => s.settings?.uiLanguage ?? null)
  const pluginLanguagePacks = usePluginLanguagePackStore((s) => s.packs)
  const pluginLanguagePacksLoaded = usePluginLanguagePackStore((s) => s.loaded)
  const { i18n } = useTranslation()
  const selectedPluginLanguage = pluginLanguagePacks.find((pack) => pack.id === uiLanguage)
  const targetLocale =
    uiLanguage === null || (isPluginUiLanguage(uiLanguage) && !pluginLanguagePacksLoaded)
      ? null
      : (selectedPluginLanguage?.resourceLanguage ??
        (isPluginUiLanguage(uiLanguage) ? 'en' : resolveUiLocale(uiLanguage)))
  const localeReady =
    targetLocale !== null &&
    i18n.language === targetLocale &&
    i18n.hasResourceBundle(targetLocale, 'translation')

  useEffect(() => {
    if (!localeReady) {
      return
    }
    return subscribeToMacosTccPromptNotice(window.api?.macosTccPrompts, () => {
      toast.warning(
        translate(
          'auto.hooks.useMacosTccPromptNotice.title',
          'Reduce repeated macOS file-access prompts'
        ),
        {
          description: translate(
            'auto.hooks.useMacosTccPromptNotice.description',
            'macOS attributes file access by your agents and terminal tools to Orca. Granting Full Disk Access reduces these prompts.'
          ),
          duration: 12_000,
          action: {
            label: translate('auto.hooks.useMacosTccPromptNotice.openSettings', 'Open Settings'),
            onClick: () => {
              openSettingsPage()
              openSettingsTarget({ pane: 'developer-permissions', repoId: null })
            }
          },
          cancel: {
            label: translate('auto.hooks.useMacosTccPromptNotice.dismiss', "Don't show again"),
            onClick: () => {
              void dismissMacosTccPromptNotice(window.api?.macosTccPrompts)
            }
          }
        }
      )
    })
  }, [localeReady, openSettingsPage, openSettingsTarget])
}
