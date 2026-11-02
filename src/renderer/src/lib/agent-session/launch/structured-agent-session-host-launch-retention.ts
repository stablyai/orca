/** A host launch's saved row is where its input is found again once nothing shows it: the host may
 *  still run the launch after this window lost its chat's tab, and a reload redraws that tab from
 *  the row's address. Only the chat showing here, or the user's own Close, ends that; a refused
 *  tab, a settlement or a reload never does. */

import type { AppState } from '@/store/types'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'

// Inject store access to break launch registry → store initialization cycles: store slices import
// the registry, which reads this.
let tabsAccessor: (() => Pick<AppState, 'unifiedTabsByWorktree'>) | null = null

export function registerHostLaunchTabsAccessor(
  fn: () => Pick<AppState, 'unifiedTabsByWorktree'>
): void {
  tabsAccessor = fn
}

export function hostLaunchAwaitsItsTab(launch: {
  cancelled: boolean
  intent: Pick<
    StructuredAgentSessionLaunchIntent,
    'hostLaunch' | 'surfaceAddress' | 'worktreeId' | 'sessionId' | 'executionHostId'
  >
}): boolean {
  const { hostLaunch, surfaceAddress, worktreeId, sessionId, executionHostId } = launch.intent
  if (!hostLaunch || !surfaceAddress || launch.cancelled) {
    return false
  }
  return !(tabsAccessor?.().unifiedTabsByWorktree[worktreeId] ?? []).some(
    (tab) =>
      tab.contentType === 'agent-session' &&
      tab.entityId === sessionId &&
      (tab.executionHostId ?? executionHostId) === executionHostId
  )
}
