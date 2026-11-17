export const AGENT_ROW_MENU_ATTR = 'data-agent-row-menu'
export const AGENT_ROW_PANE_KEY_ATTR = 'data-agent-row-pane-key'
export const AGENT_ROW_MENU_OPEN_ATTR = 'data-agent-row-menu-open'
export const WORKTREE_CARD_MENU_OPEN_ATTR = 'data-worktree-card-menu-open'

/** Rows carrying the marker open their own menu, so the card's capture handler must stand down. */
export function isAgentRowMenuTarget(target: EventTarget | null): boolean {
  const selector = `[${AGENT_ROW_MENU_ATTR}]`
  // Text-node targets have no closest(); their parent element decides.
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  return element?.closest(selector) != null
}

/** Restore focus only to a connected row that still represents the menu's agent. */
export function focusAgentRow(row: HTMLElement | null, paneKey: string): boolean {
  if (!row?.isConnected || row.getAttribute(AGENT_ROW_PANE_KEY_ATTR) !== paneKey) {
    return false
  }
  row.focus({ preventScroll: true })
  return document.activeElement === row
}
