// Why: Electron `<webview>` guest contents are destroyed whenever the host
// element is reparented in the DOM. So browser panes cannot live inside
// TabGroupPanel (which would unmount/remount them when a tab moves between
// groups). Instead, a single worktree-level BrowserPaneOverlayLayer renders
// one stable `<BrowserPane>` per browser tab and positions it over the
// owning group's body via CSS anchor positioning. This module provides the
// anchor-name bridge between the two:
//
//   TabGroupPanel body     →  `anchor-name: --orca-browser-slot-<groupId>`
//   BrowserPaneOverlayLayer overlay  →  `position-anchor: --orca-browser-slot-<groupId>`
//                                       `top: anchor(--… top); left: anchor(--… left);`
//                                       `width: anchor-size(--… width); height: anchor-size(--… height);`
//
// The browser does all layout tracking for free — no ResizeObserver, no
// rect state, no subscribe/notify machinery. Moving a tab between groups
// only changes which anchor-name the overlay references, so the `<webview>`
// is never reparented (and never reloads). Mirrors VS Code's
// `OverlayWebview` claim/release pattern, with CSS doing the positioning.

const ANCHOR_PREFIX = '--orca-browser-slot-'

/**
 * Returns the CSS anchor name for a given tab-group id. Anchor names must be
 * `<dashed-ident>`; groupIds are UUIDs (hex + `-`) so they are already safe
 * as suffixes. Prefixed so they cannot collide with unrelated anchors.
 */
export function browserSlotAnchorName(groupId: string): string {
  return `${ANCHOR_PREFIX}${groupId}`
}
