import { useCallback } from 'react'
import { useAppStore } from '@/store/index'
import { showMobileEmulatorHiddenToast } from './mobile-emulator-hidden-toast'
import { withNewTabMenuItemHidden } from '../../../../../shared/new-tab-menu/new-tab-menu-layout'

const MOBILE_EMULATOR_MENU_ITEM_ID = 'mobile-emulator'

function setMobileEmulatorHiddenInMenu(hidden: boolean): Promise<void> {
  const state = useAppStore.getState()
  return state.updateSettings({
    newTabMenuLayout: withNewTabMenuItemHidden(
      state.settings?.newTabMenuLayout,
      MOBILE_EMULATOR_MENU_ITEM_ID,
      hidden
    )
  })
}

export function useMobileEmulatorTabIntroActions(): {
  keepIntro: () => void
  hideIntro: () => void
  dismissIntro: () => void
} {
  const dismissMobileEmulatorTabIntro = useAppStore((s) => s.dismissMobileEmulatorTabIntro)

  const dismissIntro = useCallback((): void => {
    dismissMobileEmulatorTabIntro()
  }, [dismissMobileEmulatorTabIntro])

  const keepIntro = useCallback((): void => {
    dismissIntro()
  }, [dismissIntro])

  // Hide only declutters the + menu; the feature, open emulator tabs, and its shortcut keep working.
  const hideIntro = useCallback((): void => {
    dismissIntro()
    void setMobileEmulatorHiddenInMenu(true)
    showMobileEmulatorHiddenToast({ undo: () => void setMobileEmulatorHiddenInMenu(false) })
  }, [dismissIntro])

  return { keepIntro, hideIntro, dismissIntro }
}
