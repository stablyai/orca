import { createContext } from 'react'

export type ActivityThreadCollapseState = {
  collapsedGroupKeys: ReadonlySet<string>
  onToggleGroupCollapse: (groupKey: string) => void
}

/** Retain caller-owned collapsed groups across pane unmounts; explicit collapse props take precedence. */
export const ActivityThreadCollapseContext = createContext<ActivityThreadCollapseState | null>(null)
