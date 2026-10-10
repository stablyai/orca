import type { TopLevelView } from '../../../shared/ui-chrome-types'
import type { WorkspaceVisibleTabType } from '../../../shared/tab-types'

function closestFocusedElement(element: unknown, selector: string): unknown {
  if (
    typeof element === 'object' &&
    element !== null &&
    'closest' in element &&
    typeof element.closest === 'function'
  ) {
    return element.closest(selector)
  }
  return null
}

/** Zoom belongs to the focused surface within the current workspace. */
export function resolveZoomTarget(args: {
  activeView: TopLevelView
  activeTabType: WorkspaceVisibleTabType
  activeElement: unknown
}): 'terminal' | 'editor' | 'simulator' | 'chat' | 'ui' {
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
  const chatFocused = Boolean(closestFocusedElement(activeElement, '[data-native-chat-root]'))
  const editorFocused = Boolean(
    closestFocusedElement(
      activeElement,
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
  if (chatFocused) {
    return 'chat'
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
