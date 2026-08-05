import { isInsideFocusOwnedPane } from '@/lib/pane-manager/pane-pointer-focus'

// Why: when Cmd+J closes it must hand focus back to whatever the user was
// doing. Prefer the exact element focused before the palette opened (e.g. the
// specific terminal textarea they were typing in); the querySelector fallbacks
// grab the first match in the DOM, which can be a background worktree's
// mounted-but-hidden terminal rather than the visible one — or a pane whose
// native chat composer owns focus, which this must not steal from either.
export function resolvePaletteFocusRestoreTarget(
  preferredTarget: HTMLElement | null,
  doc: Document = document
): HTMLElement | null {
  if (preferredTarget && preferredTarget.isConnected) {
    return preferredTarget
  }
  const xterm = doc.querySelector('.xterm-helper-textarea')
  if (xterm instanceof HTMLElement && !isInsideFocusOwnedPane(xterm)) {
    return xterm
  }
  const monaco = doc.querySelector('.monaco-editor textarea')
  return monaco instanceof HTMLElement ? monaco : null
}
