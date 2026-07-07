/**
 * Determine which zoom domain (terminal, editor, simulator, or UI) should be adjusted
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
  activeTabType: 'terminal' | 'editor' | 'browser' | 'simulator' | 'tasks'
  activeElement: unknown
}): 'terminal' | 'editor' | 'simulator' | 'ui' {
  const { activeView, activeTabType, activeElement } = args
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
  if (activeTabType === 'simulator') {
    return 'simulator'
  }
  // Why: keyboard/menu zoom in an active browser tab belongs to Orca chrome.
  // Browser page zoom has a dedicated route for wheel and page-specific IPC.
  if (activeTabType === 'browser') {
    return 'ui'
  }
  // Why: tasks tabs are app chrome; their embedded markdown composers must not
  // route Cmd/Ctrl +/- to editor font zoom.
  if (activeTabType === 'tasks') {
    return 'ui'
  }
  if (activeTabType === 'editor' || editorFocused) {
    return 'editor'
  }
  // Why: terminal zoom is focus-owned. After the user clicks app chrome or
  // whitespace, the active terminal tab remains visible but app zoom should own
  // Cmd/Ctrl +/- until xterm focus returns.
  if (terminalInputFocused) {
    return 'terminal'
  }
  return 'ui'
}
