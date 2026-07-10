// Why: browser and terminal panes are mounted once at the worktree level and
// positioned over their owning TabGroupPanel body. A stable per-group anchor
// lets those overlays follow split-group layout changes without reparenting
// heavyweight pane DOM.

const ANCHOR_PREFIX = '--orca-tab-group-body-'

/**
 * Returns the CSS anchor name for a given tab-group id. Anchor names must be
 * `<dashed-ident>`; remote/runtime groups can include path-like ids, so encode
 * the full id into hex code points before appending it to the custom prefix.
 */
export function tabGroupBodyAnchorName(groupId: string): string {
  const encoded = Array.from(groupId, (char) => char.codePointAt(0)?.toString(16) ?? '').join('-')
  return `${ANCHOR_PREFIX}${encoded || 'empty'}`
}
