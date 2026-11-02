import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type {
  PtyManagementFolderAccessMismatch,
  PtyManagementMacTccAttributionHealth
} from '../../../preload/api-types'
import { isPluginUiLanguage } from '../../../shared/ui-language'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore, usePluginLanguagePacks } from '@/store/plugin-language-packs'
import { translate } from '@/i18n/i18n'
import { track } from '@/lib/telemetry'
import { resolveUiLocale } from '@/i18n/supported-languages'
import { MANAGE_SESSIONS_SECTION_ID } from '@/components/settings/TerminalTccAttributionNotice'
import { macFolderAccessFolderName } from '@/components/shared/mac-folder-access-folder-name'
import {
  FOLDER_ACCESS_MISMATCH_NOTICE_ID,
  useMacFolderAccessFixStore
} from '@/store/mac-folder-access-fix'

const SEVERED_TCC_NOTICE_ID = 'mac-tcc-attribution-severed'

/** Surface the existing restart remedy when daemon TCC attribution is severed or a folder is denied. */
export function useMacTccAttributionSeveredNotice(): void {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)
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

    const openManageSessions = (): void => {
      setSettingsSearchQuery('')
      openSettingsTarget({
        pane: 'terminal',
        repoId: null,
        sectionId: MANAGE_SESSIONS_SECTION_ID
      })
      openSettingsPage()
    }

    const applySeveredNotice = (health: PtyManagementMacTccAttributionHealth): void => {
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
            onClick: openManageSessions
          },
          cancel: {
            label: translate('auto.hooks.useMacTccAttributionSeveredNotice.dismiss', 'Dismiss'),
            onClick: () => {}
          }
        }
      )
    }

    const applyFolderAccessNotice = (mismatch: PtyManagementFolderAccessMismatch | null): void => {
      const { noticePhaseByScope, applyVerdict, showNotice, openFix } =
        useMacFolderAccessFixStore.getState()
      // Publish every verdict for dialog progress; null retires the notice so reconnect can legitimately re-raise it.
      applyVerdict(mismatch)
      if (!mismatch) {
        return
      }
      const { daemonScope, cwdClass } = mismatch
      const phase = noticePhaseByScope.get(daemonScope)
      if (phase === 'visible' || phase === 'dismissed') {
        return
      }
      showNotice(daemonScope)
      // Count once per evidence scope; re-raising after reconnect is not another affected user.
      if (phase === undefined) {
        track('daemon_folder_access_notice', { action: 'shown', cwd_class: cwdClass })
      }
      toast.warning(
        translate(
          'auto.hooks.useMacTccAttributionSeveredNotice.folderAccessTitle',
          'Terminals can’t read your {{folder}}',
          { folder: macFolderAccessFolderName(cwdClass) }
        ),
        {
          id: FOLDER_ACCESS_MISMATCH_NOTICE_ID,
          description: translate(
            'auto.hooks.useMacTccAttributionSeveredNotice.folderAccessDescription',
            'macOS is blocking Orca’s terminal service from this folder, so commands run there may fail until it’s fixed.'
          ),
          duration: Infinity,
          action: {
            label: translate('auto.hooks.useMacTccAttributionSeveredNotice.folderAccessFix', 'Fix'),
            onClick: (event) => {
              // Prevent Sonner’s silent action deletion so canceling the dialog still leaves the unresolved remedy visible.
              event.preventDefault()
              track('daemon_folder_access_notice', { action: 'fix_opened', cwd_class: cwdClass })
              // No captured verdict: the dialog opens on whatever the latest poll reported.
              openFix()
            }
          },
          // Use the usual X dismissal; programmatic takedown clears scope before onDismiss fires.
          onDismiss: () => {
            const store = useMacFolderAccessFixStore.getState()
            if (store.noticePhaseByScope.get(daemonScope) !== 'visible') {
              return
            }
            store.dismissNotice(daemonScope)
            track('daemon_folder_access_notice', { action: 'dismissed', cwd_class: cwdClass })
          }
        }
      )
    }

    const maybeToast = async (): Promise<void> => {
      if (checkInFlight.current) {
        return
      }
      checkInFlight.current = true
      try {
        const { health, folderAccessMismatch } = await macTccAttribution()
        applySeveredNotice(health)
        applyFolderAccessNotice(folderAccessMismatch ?? null)
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
