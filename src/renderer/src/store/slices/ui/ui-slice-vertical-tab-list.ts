import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import { clampVerticalTabListWidth } from '../../../../../shared/workspace-layout/tab-strip-position'
import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'

/** The left vertical tab list's width and collapse, shared by every split and window. */
export function createUiVerticalTabListActions(
  set: UISliceSet,
  get: UISliceGet
): Pick<
  UISlice,
  | 'verticalTabListWidth'
  | 'setVerticalTabListWidth'
  | 'verticalTabListCollapsed'
  | 'setVerticalTabListCollapsed'
> {
  return {
    verticalTabListWidth: clampVerticalTabListWidth(undefined),
    setVerticalTabListWidth: (width) => {
      const verticalTabListWidth = clampVerticalTabListWidth(width, get().verticalTabListWidth)
      if (verticalTabListWidth === get().verticalTabListWidth) {
        return
      }
      set({ verticalTabListWidth })
      window.api.ui.set({ verticalTabListWidth }).catch(console.error)
    },
    verticalTabListCollapsed: false,
    setVerticalTabListCollapsed: (verticalTabListCollapsed) => {
      set({ verticalTabListCollapsed })
      window.api.ui.set({ verticalTabListCollapsed }).catch(console.error)
    }
  }
}

export function hydrateVerticalTabListState(
  ui: PersistedUIState
): Pick<UISlice, 'verticalTabListWidth' | 'verticalTabListCollapsed'> {
  return {
    verticalTabListWidth: clampVerticalTabListWidth(ui.verticalTabListWidth),
    verticalTabListCollapsed: ui.verticalTabListCollapsed === true
  }
}
