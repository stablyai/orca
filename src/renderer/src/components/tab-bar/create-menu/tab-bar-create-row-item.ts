import type React from 'react'
import type { KeybindingActionId } from '../../../../../shared/keybindings/types'
import type { NewTabMenuArrangeable } from '../../../../../shared/new-tab-menu/new-tab-menu-layout'

// Ids persisted in newTabMenuLayout; renaming one loses users' saved placement.
export const CREATE_ROW_TERMINAL_ID = 'terminal'
export const CREATE_ROW_MOBILE_EMULATOR_ID = 'mobile-emulator'

/** One icon in the + menu's create row. */
export type TabBarCreateRowItem = NewTabMenuArrangeable & {
  label: string
  /** Secondary text in the customizer, e.g. the plugin that contributes the item. */
  detail?: string
  icon: React.ReactNode
  /** The shortcut that runs this item outside the menu, editable from the customizer. */
  actionId?: KeybindingActionId
  run: () => void
  /** Set when the feature behind this item is turned off; showing the item turns it back on. */
  enable?: () => Promise<void>
}
