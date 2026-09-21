import { createContext } from 'react'

export type ActivityThreadCollapseState = {
  collapsedGroupKeys: ReadonlySet<string>
  onToggleGroupCollapse: (groupKey: string) => void
}

/**
 * Caller-owned collapse state for ActivityThreadListPane hosts that unmount the
 * pane (sidebar body switches) but should keep the user's collapsed groups.
 * Explicit collapsedGroupKeys/onToggleGroupCollapse props take precedence.
 */
export const ActivityThreadCollapseContext = createContext<ActivityThreadCollapseState | null>(null)
