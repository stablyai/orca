// Why: background PTYs (automation agents, worktree setup tabs) spawn before
// any pane mounts, so there is no grid to fit to — they use this fixed grid.
// Everything the TUI draws into the eager buffer is rendered at this size, so
// attach-time replay must re-parse it at the same grid (via EagerPtyHandle
// captureDims) or inline TUIs like Cursor CLI anchor their cursor on the
// wrong row after adoption.
export const BACKGROUND_PTY_SPAWN_SIZE = { cols: 120, rows: 40 } as const
