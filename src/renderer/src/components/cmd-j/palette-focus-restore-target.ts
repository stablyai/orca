// Prefer the exact pre-palette focus target; querySelector fallbacks may pick a retained background terminal.
export function resolvePaletteFocusRestoreTarget(
  preferredTarget: HTMLElement | null,
  doc: Document = document
): HTMLElement | null {
  if (preferredTarget && preferredTarget.isConnected) {
    return preferredTarget
  }
  const xterm = doc.querySelector('.xterm-helper-textarea')
  if (xterm instanceof HTMLElement) {
    return xterm
  }
  const monaco = doc.querySelector('.monaco-editor textarea')
  return monaco instanceof HTMLElement ? monaco : null
}
