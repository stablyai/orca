import {
  PANE_CONTAINER_SELECTOR,
  resolvePaneSurfaceFocusTarget,
  resolveVisibleTerminalSurfaceTarget
} from '@/lib/pane-manager/pane-surface-focus'

// Why: when Cmd+J closes it must hand focus back to whatever the user was
// doing. Prefer the exact element focused before the palette opened (e.g. the
// specific terminal textarea they were typing in). Fallbacks route through
// resolveVisibleTerminalSurfaceTarget so a hidden background pane can't be
// picked and a chat-owned pane yields its composer, not the hidden xterm.
export function resolvePaletteFocusRestoreTarget(
  preferredTarget: HTMLElement | null,
  doc: Document = document
): HTMLElement | null {
  if (preferredTarget && preferredTarget.isConnected) {
    // Why: the captured element can be an xterm helper whose pane has since
    // switched to chat mode; its keyboard surface is now the composer.
    if (preferredTarget.classList.contains('xterm-helper-textarea')) {
      const pane = preferredTarget.closest(PANE_CONTAINER_SELECTOR) as HTMLElement | null
      const owned = pane ? resolvePaneSurfaceFocusTarget(pane) : null
      return owned ?? preferredTarget
    }
    return preferredTarget
  }
  const terminalSurface = resolveVisibleTerminalSurfaceTarget(doc)
  if (terminalSurface) {
    return terminalSurface
  }
  const monaco = doc.querySelector('.monaco-editor textarea')
  return monaco instanceof HTMLElement ? monaco : null
}
