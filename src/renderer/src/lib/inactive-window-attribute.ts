/** Present on <html> while this window lacks OS focus; CSS rests decorative motion with it. */
export const INACTIVE_WINDOW_ATTRIBUTE = 'data-window-inactive'

let disposeInstalledAttribute: (() => void) | null = null

/** Mirrors the window's OS focus onto the root element until disposed. */
export function installInactiveWindowAttribute(): () => void {
  if (disposeInstalledAttribute) {
    return disposeInstalledAttribute
  }

  const setInactive = (inactive: boolean): void => {
    document.documentElement.toggleAttribute(INACTIVE_WINDOW_ATTRIBUTE, inactive)
  }
  const unsubscribe = window.api.ui.onWindowFocusChanged((focused) => setInactive(!focused))
  setInactive(!document.hasFocus())

  const dispose = (): void => {
    unsubscribe()
    document.documentElement.removeAttribute(INACTIVE_WINDOW_ATTRIBUTE)
    if (disposeInstalledAttribute === dispose) {
      disposeInstalledAttribute = null
    }
  }
  disposeInstalledAttribute = dispose
  return dispose
}
