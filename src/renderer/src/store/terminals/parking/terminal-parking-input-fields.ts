export const SEAM_PARKING_TAB_FIELDS = [
  'terminalLayoutsByTabId',
  'ptyIdsByTabId',
  'lastKnownRelayPtyIdByTabId',
  'runtimePaneTitlesByTabId',
  'pendingStartupByTabId'
] as const

export const SEAM_PARKING_WORKSPACE_FIELDS = [
  'layoutByWorktree',
  'groupsByWorktree',
  'activeGroupIdByWorktree'
] as const
