export type EditorTabCloseSettings = {
  /** Why: closes clean unpinned editor tabs when focus leaves the tab bar or editor; dirty tabs stay open. Absent reads as off. */
  closeUnpinnedEditorTabsOnFocusLoss?: boolean
}
