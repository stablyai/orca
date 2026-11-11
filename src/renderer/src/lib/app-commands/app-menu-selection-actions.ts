export const APP_MENU_SELECTION_ACTION_EVENT = 'orca-app-menu-selection-action'

export type AppMenuSelectionAction = 'copy' | 'select-all'

export function dispatchAppMenuSelectionAction(
  action: AppMenuSelectionAction,
  target: Window = window
): boolean {
  const event = new CustomEvent<AppMenuSelectionAction>(APP_MENU_SELECTION_ACTION_EVENT, {
    detail: action,
    cancelable: true
  })
  target.dispatchEvent(event)
  return event.defaultPrevented
}
