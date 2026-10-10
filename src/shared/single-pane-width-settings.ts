export type SinglePaneWidthSettings = {
  /** Max width in px for a tab area showing one unsplit pane of any type (terminal,
   *  browser, editor, markdown preview); the pane centers in the remaining space.
   *  Undefined keeps the 1100px CSS default; 0 restores full width. */
  terminalSinglePaneMaxWidth?: number
}
