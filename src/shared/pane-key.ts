/** Why: CLI-spawned terminals bake `paneKey = `${tabId}:${FIRST_PANE_ID}`` into
 *  the PTY env at spawn time, before any pane has actually been allocated.
 *  This constant must match the renderer's PaneManager.nextPaneId initial
 *  value so hook events route to the first pane. See
 *  docs/cli-terminal-hook-pane-key.md. */
export const FIRST_PANE_ID = 1
