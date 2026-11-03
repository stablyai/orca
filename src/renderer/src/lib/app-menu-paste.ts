export const APP_MENU_PASTE_EVENT = 'orca-app-menu-paste'

export type AppMenuPasteRequestResult =
  | { status: 'handled'; target: 'terminal' }
  | { status: 'native-fallback'; reason: 'no-owned-target' }

export type AppMenuPasteRequestDeps = {
  performNativePaste: (options?: { mode?: 'paste' | 'paste-and-match-style' }) => void
  dispatchOwnedPasteEvent?: (mode: 'paste' | 'paste-and-match-style') => boolean
  nativePasteMode?: 'paste' | 'paste-and-match-style'
}

export function dispatchAppMenuPasteEvent(
  target: Window = window,
  mode: 'paste' | 'paste-and-match-style' = 'paste'
): boolean {
  const event = new CustomEvent(APP_MENU_PASTE_EVENT, {
    detail: mode,
    bubbles: false,
    cancelable: true
  })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

export function handleAppMenuPasteRequest({
  performNativePaste,
  dispatchOwnedPasteEvent = (mode) => dispatchAppMenuPasteEvent(window, mode),
  nativePasteMode = 'paste'
}: AppMenuPasteRequestDeps): AppMenuPasteRequestResult {
  if (dispatchOwnedPasteEvent(nativePasteMode)) {
    return { status: 'handled', target: 'terminal' }
  }

  // Avoid a separate clipboard read; native events still pass through the document's large-paste guard.
  performNativePaste({ mode: nativePasteMode })
  return { status: 'native-fallback', reason: 'no-owned-target' }
}
