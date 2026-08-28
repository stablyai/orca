import { getActiveEntityIdForTabType, type TabCycleType } from '../terminal/tab-type-cycle'
import { getActiveGroupTabIdInNavOrder, getActiveTabNavOrder } from './group-tab-order'

export type TabCloseScope = 'others' | 'right' | 'left'

type TabCloseScopeState = Parameters<typeof getActiveTabNavOrder>[0] & {
  activeTabType: TabCycleType
  activeTabId: string | null
  activeFileId: string | null
  activeBrowserTabId: string | null
}

/**
 * The visible tab ids a scoped close should target, relative to the focused tab.
 *
 * Walks the same order the active tab strip renders (`getActiveTabNavOrder`), so the
 * keyboard actions close exactly what the "Close Others / To The Right / To The Left"
 * context-menu items would in the surface the user is looking at. Ids stay in the
 * visible-id domain the bulk-close paths take (entity id for terminals, browsers and
 * editor files; unified tab id for simulators); pinned and dirty handling belongs to
 * those paths, not here. Returns [] when the focused tab isn't in the visible order.
 */
export function resolveTabCloseScopeTargets(
  state: TabCloseScopeState,
  worktreeId: string,
  scope: TabCloseScope
): string[] {
  const order = getActiveTabNavOrder(state, worktreeId)
  const groupTabIdInNav = getActiveGroupTabIdInNavOrder(state, worktreeId, order)
  const activeEntityId = getActiveEntityIdForTabType(
    state.activeTabType,
    state.activeTabId,
    state.activeFileId,
    state.activeBrowserTabId
  )
  const focusedIndex = groupTabIdInNav
    ? order.findIndex((entry) => entry.tabId === groupTabIdInNav)
    : order.findIndex((entry) => entry.type === state.activeTabType && entry.id === activeEntityId)
  if (focusedIndex === -1) {
    return []
  }
  const targets =
    scope === 'others'
      ? order.filter((_, index) => index !== focusedIndex)
      : scope === 'right'
        ? order.slice(focusedIndex + 1)
        : order.slice(0, focusedIndex)
  return targets.map((entry) => entry.id)
}
