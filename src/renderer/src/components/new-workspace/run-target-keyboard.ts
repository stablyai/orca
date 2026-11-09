import type { RunTargetRowModel, RunTargetSubmenu } from './run-target-options'

export type RunTargetKeyboardState = {
  open: boolean
  query: string
  submenu: RunTargetSubmenu | null
  /** Non-null once keyboard (or pointer) focus has moved into the open submenu. */
  armedItemKey: string | null
  armedRow: RunTargetRowModel | null
}

export type RunTargetKeyboardActions = {
  setOpen: (open: boolean) => void
  moveArm: (step: number) => void
  moveItemArm: (step: number) => void
  activate: (key: string | null) => void
  commitSubmenuItem: (key: string) => void
  closeSubmenu: () => void
  close: () => void
}

/**
 * Listbox-with-submenus keys for the Run-on input: Up/Down move within whichever list holds the
 * arm, Enter commits it, Right/Enter on a submenu row moves into it, Left/Escape back out.
 */
export function handleRunTargetKeyDown(
  event: Pick<React.KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'>,
  state: RunTargetKeyboardState,
  actions: RunTargetKeyboardActions
): void {
  const { open, query, submenu, armedItemKey, armedRow } = state
  const inSubmenu = submenu !== null && armedItemKey !== null
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    if (inSubmenu) {
      actions.moveItemArm(step)
      return
    }
    actions.setOpen(true)
    actions.moveArm(step)
    actions.closeSubmenu()
    return
  }
  if (event.key === 'Enter' && open) {
    event.preventDefault()
    if (inSubmenu) {
      actions.commitSubmenuItem(armedItemKey)
      return
    }
    actions.activate(armedRow?.key ?? null)
    return
  }
  // Left/Right still move the caret unless they cross a submenu boundary.
  const armedOpensSubmenu = armedRow?.kind === 'recipes' || armedRow?.kind === 'add-host'
  if (event.key === 'ArrowRight' && open && !inSubmenu && armedOpensSubmenu) {
    event.preventDefault()
    actions.activate(armedRow.key)
    return
  }
  if (event.key === 'ArrowLeft' && inSubmenu) {
    event.preventDefault()
    actions.closeSubmenu()
    return
  }
  if (event.key === 'Escape' && (open || query.length > 0)) {
    event.preventDefault()
    event.stopPropagation()
    // Escape backs out one level: out of a keyboard-entered submenu first, then the list.
    if (inSubmenu) {
      actions.closeSubmenu()
      return
    }
    actions.close()
  }
}
