import type React from 'react'
import { focusCascadedAddProjectMenuFirstItem } from './ProjectComboboxAddProjectOption'

export const PROJECT_COMBOBOX_ADD_PROJECT_KEY = 'add-project'

export type ProjectComboboxKeyDownState = {
  open: boolean
  armedKey: string | null
  query: string
  committed: boolean
  committedName: string
  cascadeOpen: boolean
  hasAddProjectMenu: boolean
  setOpen: (open: boolean) => void
  setQuery: (query: string) => void
  setCascadeOpen: (open: boolean) => void
  setCascadeAutoFocus: (autoFocus: boolean) => void
  moveArm: (step: number) => void
  commit: (key: string | null) => void
  close: () => void
}

/** The project field's keys: arrows move the shared cursor, Enter/→ on Add project opens its cascade. */
export function handleProjectComboboxKeyDown(
  event: React.KeyboardEvent<HTMLInputElement>,
  state: ProjectComboboxKeyDownState
): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    state.setCascadeOpen(false)
    state.setOpen(true)
    state.moveArm(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (
    (event.key === 'Enter' || event.key === 'ArrowRight') &&
    state.open &&
    state.armedKey === PROJECT_COMBOBOX_ADD_PROJECT_KEY &&
    state.hasAddProjectMenu
  ) {
    event.preventDefault()
    state.setCascadeAutoFocus(true)
    if (state.cascadeOpen) {
      focusCascadedAddProjectMenuFirstItem()
    } else {
      state.setCascadeOpen(true)
    }
    return
  }
  if (event.key === 'Enter' && state.open) {
    event.preventDefault()
    state.commit(state.armedKey)
    return
  }
  // Handle Escape even while closed to clear stranded queries; bubble only when there is no committed display to restore.
  if (event.key === 'Escape' && (state.open || state.query.length > 0)) {
    event.preventDefault()
    event.stopPropagation()
    if (state.cascadeOpen) {
      state.setCascadeOpen(false)
      return
    }
    state.close()
    return
  }
  if (event.key === 'Backspace' && state.committed) {
    event.preventDefault()
    state.setCascadeOpen(false)
    state.setQuery(state.committedName)
    state.setOpen(true)
  }
}
