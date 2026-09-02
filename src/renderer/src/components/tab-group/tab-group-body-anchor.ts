// Why: browser and terminal panes are mounted once at the worktree level and
// positioned over their owning TabGroupPanel body. A stable per-group anchor
// lets those overlays follow split-group layout changes without reparenting
// heavyweight pane DOM.

const ANCHOR_PREFIX = '--orca-tab-group-body-'
const CANVAS_TERMINAL_ANCHOR_PREFIX = '--orca-canvas-terminal-body-'

function encodeAnchorId(id: string): string {
  return Array.from(id, (char) => char.codePointAt(0)?.toString(16) ?? '').join('-') || 'empty'
}

/**
 * Returns the CSS anchor name for a given tab-group id. Anchor names must be
 * `<dashed-ident>`; remote/runtime groups can include path-like ids, so encode
 * the full id into hex code points before appending it to the custom prefix.
 */
export function tabGroupBodyAnchorName(groupId: string): string {
  return `${ANCHOR_PREFIX}${encodeAnchorId(groupId)}`
}

/** Positions a persistent terminal overlay inside its independent Canvas card. */
export function terminalCanvasBodyAnchorName(terminalTabId: string): string {
  return `${CANVAS_TERMINAL_ANCHOR_PREFIX}${encodeAnchorId(terminalTabId)}`
}
