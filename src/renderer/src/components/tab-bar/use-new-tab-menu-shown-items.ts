import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import {
  isNewTabMenuItemHidden,
  type NewTabMenuHideableItem
} from '../../../../shared/new-tab-menu-items'

export type NewTabMenuShownItems = Record<NewTabMenuHideableItem, boolean>

/** User preference only; callers still AND it with each row's availability. */
export function useNewTabMenuShownItems(): NewTabMenuShownItems {
  return useAppStore(
    useShallow((state) => {
      const hidden = state.settings?.newTabMenuHiddenItems
      return {
        browser: !isNewTabMenuItemHidden(hidden, 'browser'),
        'new-markdown': !isNewTabMenuItemHidden(hidden, 'new-markdown'),
        'open-markdown': !isNewTabMenuItemHidden(hidden, 'open-markdown'),
        'mobile-emulator': !isNewTabMenuItemHidden(hidden, 'mobile-emulator')
      }
    })
  )
}
