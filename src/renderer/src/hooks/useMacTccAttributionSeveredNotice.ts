import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isPluginUiLanguage } from '../../../shared/ui-language'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import { translate } from '@/i18n/i18n'
import { resolveUiLocale } from '@/i18n/supported-languages'
import { MANAGE_SESSIONS_SECTION_ID } from '@/components/settings/TerminalTccAttributionNotice'

const SEVERED_TCC_NOTICE_ID = 'mac-tcc-attribution-severed'

/** Surface the existing restart remedy once when daemon TCC attribution is severed. */
export function useMacTccAttributionSeveredNotice(): void {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)
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
  const toastedThisSession = useRef(false)
  // Why: toast was only marked after await; a focus/effect re-run mid-check could dual-toast.
  const checkInFlight = useRef(false)

  useEffect(() => {
    if (
      !localeReady ||
      typeof window === 'undefined' ||
      window.api?.platform?.get().platform !== 'darwin'
    ) {
      return
    }
    const macTccAttribution = window.api?.pty?.management?.macTccAttribution
    if (!macTccAttribution) {
      return
    }

    const maybeToast = async (): Promise<void> => {
      if (checkInFlight.current) {
        return
      }
      checkInFlight.current = true
      try {
        const { health } = await macTccAttribution()
        if (health !== 'severed') {
          if (toastedThisSession.current) {
            toast.dismiss(SEVERED_TCC_NOTICE_ID)
          }
          return
        }
        if (toastedThisSession.current) {
          return
        }
        toastedThisSession.current = true
        toast.warning(
          translate(
            'auto.hooks.useMacTccAttributionSeveredNotice.title',
            'macOS permissions may not reach Orca terminals'
          ),
          {
            id: SEVERED_TCC_NOTICE_ID,
            description: translate(
              'auto.hooks.useMacTccAttributionSeveredNotice.description',
              'Running Orca terminals are hosted by a daemon started by a previous Orca installation. macOS may not apply Orca’s Accessibility, Automation, or protected-file permissions to them. Restart the daemon from Manage Sessions to restore access. This will close all running Orca terminals.'
            ),
            duration: Infinity,
            action: {
              label: translate(
                'auto.hooks.useMacTccAttributionSeveredNotice.openManageSessions',
                'Open Manage Sessions'
              ),
              onClick: () => {
                setSettingsSearchQuery('')
                openSettingsTarget({
                  pane: 'terminal',
                  repoId: null,
                  sectionId: MANAGE_SESSIONS_SECTION_ID
                })
                openSettingsPage()
              }
            },
            cancel: {
              label: translate('auto.hooks.useMacTccAttributionSeveredNotice.dismiss', 'Dismiss'),
              onClick: () => {}
            }
          }
        )
      } catch {
        // Rejection clears the guard so a later focus can retry.
      } finally {
        checkInFlight.current = false
      }
    }

    void maybeToast()
    const onFocus = (): void => {
      void maybeToast()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [localeReady, openSettingsPage, openSettingsTarget, setSettingsSearchQuery])
}
