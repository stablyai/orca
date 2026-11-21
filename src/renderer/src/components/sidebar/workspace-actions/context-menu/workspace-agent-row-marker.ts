// Agent rows inside a workspace card: their right-click opens the workspace menu without Delete,
// since the highlighted agent reads as the menu's subject and Delete would remove the whole workspace.

/** Set on the root of every agent row a workspace card renders, compact or full. */
export const WORKSPACE_AGENT_ROW_ATTR = 'data-workspace-agent-row'

const SCOPE_SELECTOR = '[data-worktree-context-menu-scope]'

/**
 * Whether a context menu event came from an agent row this menu scope owns. Keyboard-opened menus carry
 * the focused element, so a focused control inside a row counts as the row. A row inside a nested
 * card's scope belongs to that card's menu.
 */
export function isFromWorkspaceAgentRow(scope: Element, target: EventTarget | null): boolean {
  const start =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  const row = start?.closest(`[${WORKSPACE_AGENT_ROW_ATTR}]`) ?? null
  return row !== null && row.closest(SCOPE_SELECTOR) === scope
}
