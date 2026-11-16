import { useCallback } from 'react'
import { useAppStore } from '@/store/index'
import { showMobileEmulatorHiddenToast } from './mobile-emulator-hidden-toast'
import { CREATE_ROW_MOBILE_EMULATOR_ID } from '../../tab-bar/tab-bar-create-row-item'
import { withNewTabMenuItemHidden } from '../../../../../shared/new-tab-menu/new-tab-menu-layout'

function setMobileEmulatorHiddenInMenu(hidden: boolean): Promise<void> {
  const state = useAppStore.getState()
  return state.updateSettings({
    newTabMenuLayout: withNewTabMenuItemHidden(
      state.settings?.newTabMenuLayout,
      CREATE_ROW_MOBILE_EMULATOR_ID,
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
