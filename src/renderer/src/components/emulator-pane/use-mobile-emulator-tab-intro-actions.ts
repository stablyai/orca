import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { showMobileEmulatorHiddenToast } from './mobile-emulator-hidden-toast'
import { translate } from '@/i18n/i18n'

function closeAllSimulatorTabs(): void {
  const state = useAppStore.getState()
  for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.contentType === 'simulator') {
        state.closeUnifiedTab(tab.id)
      }
    }
  }
}

function isMobileEmulatorHidden(): boolean {
  return useAppStore.getState().settings?.mobileEmulatorEnabled === false
}

export function useMobileEmulatorTabIntroActions(): {
  keepIntro: () => void
  hideIntro: () => void
  dismissIntro: () => void
} {
  const dismissMobileEmulatorTabIntro = useAppStore((s) => s.dismissMobileEmulatorTabIntro)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const dismissIntro = useCallback((): void => {
    dismissMobileEmulatorTabIntro()
  }, [dismissMobileEmulatorTabIntro])

  const keepIntro = useCallback((): void => {
    dismissIntro()
  }, [dismissIntro])

  const hideIntro = useCallback((): void => {
    void (async () => {
      try {
        await updateSettings({ mobileEmulatorEnabled: false })
        // Why: updateSettings catches write failures; only close tabs once the
        // persisted setting is reflected in state.
        if (!isMobileEmulatorHidden()) {
          toast.error(
            translate(
              'auto.components.emulator.pane.use.mobile.emulator.tab.intro.actions.68a5dc6604',
              'Could not hide Mobile Emulator.'
            )
          )
          return
        }
        dismissIntro()
        closeAllSimulatorTabs()
        showMobileEmulatorHiddenToast({ openSettingsPage, openSettingsTarget })
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.emulator.pane.use.mobile.emulator.tab.intro.actions.68a5dc6604',
                'Could not hide Mobile Emulator.'
              )
        )
      }
    })()
  }, [dismissIntro, openSettingsPage, openSettingsTarget, updateSettings])

  return { keepIntro, hideIntro, dismissIntro }
}
