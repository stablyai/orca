import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import { showMobileEmulatorHiddenToast } from './mobile-emulator-hidden-toast'
import { CREATE_ROW_MOBILE_EMULATOR_ID } from '../../tab-bar/create-menu/tab-bar-create-row-item'
import { withNewTabMenuItemHidden } from '../../../../../shared/new-tab-menu/new-tab-menu-layout'

/** Saves the + menu visibility; reports a failed write instead of pretending it stuck. */
async function setMobileEmulatorHiddenInMenu(hidden: boolean): Promise<boolean> {
  const state = useAppStore.getState()
  try {
    await state.updateSettingsOrThrow({
      newTabMenuLayout: withNewTabMenuItemHidden(
        state.settings?.newTabMenuLayout,
        CREATE_ROW_MOBILE_EMULATOR_ID,
        hidden
      )
    })
    return true
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate('emulatorPane.tabIntro.saveFailed', 'Could not update the + menu.')
    )
    return false
  }
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
    void setMobileEmulatorHiddenInMenu(true).then((saved) => {
      if (saved) {
        showMobileEmulatorHiddenToast({ undo: () => void setMobileEmulatorHiddenInMenu(false) })
      }
    })
  }, [dismissIntro])

  return { keepIntro, hideIntro, dismissIntro }
}
