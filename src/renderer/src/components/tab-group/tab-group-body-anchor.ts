// Why: browser and terminal panes are mounted once at the worktree level and
// positioned over their owning TabGroupPanel body. A stable per-group anchor
// lets those overlays follow split-group layout changes without reparenting
// heavyweight pane DOM.

const ANCHOR_PREFIX = '--orca-tab-group-body-'

/**
 * Returns the CSS anchor name for a given tab-group id. Anchor names must be
 * `<dashed-ident>`; groupIds are UUIDs (hex + `-`) so they are already safe
 * as suffixes. Prefixed so they cannot collide with unrelated anchors.
 */
export function tabGroupBodyAnchorName(groupId: string): string {
  return `${ANCHOR_PREFIX}${groupId}`
}
