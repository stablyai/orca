import type { DashboardCardSurfaceKind } from '../../../../shared/dashboard-snapshot'
import { structuredAgentSessionIdFromTabId } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { DashboardAgentRow } from './useDashboardData'

export function resolveDashboardCardSurface(args: {
  row: Pick<DashboardAgentRow, 'entry'>
  tabId: string
  unifiedTabs: readonly Tab[] | undefined
}): {
  surfaceKind?: DashboardCardSurfaceKind
  structuredSessionId?: string
} {
  const structuredTab = args.unifiedTabs?.find(
    (tab) => tab.id === args.tabId && tab.contentType === 'agent-session'
  )
  const structuredSessionId =
    typeof structuredTab?.entityId === 'string' && structuredTab.entityId.length > 0
      ? structuredTab.entityId
      : args.row.entry.structuredHostOwned === true
        ? structuredAgentSessionIdFromTabId(args.tabId)
        : undefined
  if (structuredTab || args.row.entry.structuredHostOwned === true) {
    return {
      surfaceKind: 'structured-chat',
      ...(structuredSessionId ? { structuredSessionId } : {})
    }
  }
  return {}
}
