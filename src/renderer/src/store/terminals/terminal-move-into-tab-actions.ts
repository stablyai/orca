export type TerminalMoveIntoTabActions = {
  /**
   * A single-pane tab's live PTY joins another tab's layout: the source's SSH ledger slots,
   * scrollback, unread and agent identity follow the pane. Runs before the source tab closes.
   * It does not write tab PTY ownership (`ptyIdsByTabId`, tab rows): the caller binds the PTY to
   * the target with `updateTabPtyId` after `setTabLayout`, and `closeTab` drops the source's.
   */
  syncPaneMoveIntoTabPtyOwnership: (args: {
    movedLeafId: string
    movedPtyId: string
    sourceTabId: string
    targetTabId: string
  }) => void
}
