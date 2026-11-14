import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isPluginUiLanguage } from '../../../shared/ui-language'
import { useAppStore } from '@/store/index'
import {
  usePluginLanguagePackStore,
  usePluginLanguagePacks
} from '@/store/plugins/localization/plugin-language-packs'
import { resolveUiLocale } from '@/i18n/supported-languages'
import { FullDiskAccessNudgeToast } from '@/components/macos-permissions/FullDiskAccessNudgeToast'
import { FULL_DISK_ACCESS_SETTINGS_TARGET_ID } from '@/components/settings/navigation/settings-navigation-types'
import {
  dismissMacosTccPromptNotice,
  subscribeToMacosTccPromptNotice
} from './macos-tcc-prompt-notice-subscription'

/**
 * Shows the Full Disk Access hint after macOS raises a consent dialog naming
 * Orca (#9756). Users who never see one never see this.
 */
export function useMacosTccPromptNotice(): void {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const uiLanguage = useAppStore((s) => s.settings?.uiLanguage ?? null)
  const pluginLanguagePacks = usePluginLanguagePacks()
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
    return subscribeToMacosTccPromptNotice(
      window.api?.macosTccPrompts,
      ({ promptCount }, acknowledge) => {
        toast.custom(
          (toastId) => (
            <FullDiskAccessNudgeToast
              promptCount={promptCount}
              onClose={() => toast.dismiss(toastId)}
              onEnable={() => {
                acknowledge()
                openSettingsPage()
                openSettingsTarget({
                  pane: 'developer-permissions',
                  repoId: null,
                  sectionId: FULL_DISK_ACCESS_SETTINGS_TARGET_ID
                })
                toast.dismiss(toastId)
              }}
              onDontShowAgain={() => {
                void dismissMacosTccPromptNotice(window.api?.macosTccPrompts)
                toast.dismiss(toastId)
              }}
            />
          ),
          {
            duration: Infinity,
            closeButton: false,
            unstyled: true,
            onDismiss: acknowledge
          }
        )
      }
    )
  }, [localeReady, openSettingsPage, openSettingsTarget])
}
