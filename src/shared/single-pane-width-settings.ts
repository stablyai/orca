export type SinglePaneWidthSettings = {
  /** Max width in px for a tab holding a single unsplit pane, which then centers in the
   *  available space. Undefined keeps the 1100px CSS default; 0 restores full width. */
  terminalSinglePaneMaxWidth?: number
}
