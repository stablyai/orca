/**
 * When a cloud cover (waking overlay, asleep or archived view) unmounts while it held focus, the
 * browser drops focus to <body>. Give it back to the workspace's active tab, but never steal it
 * from anywhere else the user has moved to.
 */
export function returnFocusToWorkspace(
  activeTabId: string | null | undefined,
  focusTab: (tabId: string) => void,
  doc: Pick<Document, 'activeElement' | 'body'> = document
): boolean {
  if (doc.activeElement && doc.activeElement !== doc.body) {
    return false
  }
  if (!activeTabId) {
    return false
  }
  focusTab(activeTabId)
  return true
}
