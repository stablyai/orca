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

const BROWSER_PAGE_ID_ATTRIBUTES = [
  'data-browser-page-pane-id',
  'data-browser-page-viewport-id',
  'data-browser-page-menu-id'
]

/**
 * The browser page that holds focus: its address bar or toolbar, its open "..." menu, or the
 * page itself. The page's <webview> and the menu both live outside the pane.
 */
export function focusedBrowserPageId(activeElement: unknown): string | null {
  for (const attribute of BROWSER_PAGE_ID_ATTRIBUTES) {
    const owner = closestFocusedElement(activeElement, `[${attribute}]`)
    if (
      typeof owner === 'object' &&
      owner !== null &&
      'getAttribute' in owner &&
      typeof owner.getAttribute === 'function'
    ) {
      const browserPageId: unknown = owner.getAttribute(attribute)
      return typeof browserPageId === 'string' ? browserPageId : null
    }
  }
  return null
}

/** Zoom belongs to the focused surface within the current workspace. */
export function resolveZoomTarget(args: {
  activeView: TopLevelView
  activeTabType: WorkspaceVisibleTabType
  activeElement: unknown
}): 'terminal' | 'editor' | 'simulator' | 'chat' | 'browser' | 'ui' {
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

  // Why first: as in Chrome, zooming from the address bar or toolbar zooms the page, and a
  // floating browser can hold focus over Tasks or Settings.
  if (focusedBrowserPageId(activeElement)) {
    return 'browser'
  }
  if (activeView !== 'terminal') {
    return 'ui'
  }
  if (activeTabType === 'simulator') {
    return 'simulator'
  }
  // Why: with focus outside the pane, the chord belongs to Orca's own zoom.
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
