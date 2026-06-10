/**
 * Determine which zoom domain (terminal, editor, or UI) should be adjusted
 * based on current view, tab type, and focused element.
 */
export function resolveZoomTarget(args: {
  activeView:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'space'
    | 'skills'
    | 'mobile'
  activeTabType: 'terminal' | 'editor' | 'browser' | 'simulator'
  activeBrowserPageId?: string | null
  activeElement: unknown
}): 'terminal' | 'editor' | 'browser' | 'simulator' | 'ui' {
  const { activeView, activeTabType, activeBrowserPageId, activeElement } = args
  const terminalInputFocused =
    typeof activeElement === 'object' &&
    activeElement !== null &&
    'classList' in activeElement &&
    typeof (activeElement as { classList?: { contains?: unknown } }).classList?.contains ===
      'function' &&
    (activeElement as { classList: { contains: (token: string) => boolean } }).classList.contains(
      'xterm-helper-textarea'
    )
  const editorFocused =
    typeof activeElement === 'object' &&
    activeElement !== null &&
    'closest' in activeElement &&
    typeof (activeElement as { closest?: unknown }).closest === 'function' &&
    Boolean(
      (
        activeElement as {
          closest: (selector: string) => Element | null
        }
      ).closest(
        '.monaco-editor, .diff-editor, .markdown-preview, .rich-markdown-editor, .rich-markdown-editor-shell'
      )
    )

  if (activeView !== 'terminal') {
    return 'ui'
  }
  // Why: a browser tab owns zoom shortcuts even if DOM focus still points at a
  // just-deactivated editor or terminal during tab switches.
  if (activeTabType === 'browser' && activeBrowserPageId) {
    return 'browser'
  }
  if (activeTabType === 'simulator') {
    return 'simulator'
  }
  if (activeTabType === 'editor' || editorFocused) {
    return 'editor'
  }
  // Why: terminal tabs should keep using per-pane terminal font zoom even when
  // focus leaves the xterm textarea (e.g. clicking tab bar/sidebar controls).
  // Falling back to UI zoom here would resize the whole app for a terminal-only
  // action and break parity with terminal zoom behavior.
  if (activeTabType === 'terminal' || terminalInputFocused) {
    return 'terminal'
  }
  return 'ui'
}
