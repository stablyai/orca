import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'
import type { Tab } from '../../../../shared/tab-types'

export type StructuredTab = Tab & { contentType: 'agent-session' }

const structuredTabsByUnifiedTabsSnapshot = new WeakMap<
  Record<string, Tab[]>,
  readonly StructuredTab[]
>()

/** Project structured-session tabs once per immutable tab-map snapshot. */
export function getStructuredAgentSessionTabs(
  unifiedTabsByWorktree: Record<string, Tab[]>
): readonly StructuredTab[] {
  const cached = structuredTabsByUnifiedTabsSnapshot.get(unifiedTabsByWorktree)
  if (cached) {
    return cached
  }

  const tabs: StructuredTab[] = []
  for (const worktreeTabs of Object.values(unifiedTabsByWorktree)) {
    for (const tab of worktreeTabs) {
      if (isStructuredTab(tab)) {
        tabs.push(tab)
      }
    }
  }
  structuredTabsByUnifiedTabsSnapshot.set(unifiedTabsByWorktree, tabs)
  return tabs
}
