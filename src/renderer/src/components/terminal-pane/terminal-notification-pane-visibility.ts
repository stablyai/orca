export function isOrcaWindowForegroundFocused(): boolean {
  if (typeof document === 'undefined') {
    return true
  }
  return document.visibilityState === 'visible' && document.hasFocus()
}
