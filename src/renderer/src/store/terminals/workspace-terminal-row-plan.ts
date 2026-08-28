import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import {
  collectReleasedLeafIds,
  hydrateWorkspaceTerminalRows
} from '../slices/terminal-session-row-hydration'
import { removeSleepingAgentSessionsForTab } from '../slices/terminal-tab-retirement'
import type { HydrateWorkspaceSessionOptions } from './terminal-contracts'

export type WorkspaceTerminalRowPlan = {
  canonicalTabIdBySubsumedTabId: Map<string, string>
  reconnectPtyIdByRetainedTabId: Map<string, string>
  releasedPtyIdsByTabId: Map<string, Set<string>>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
  tabsByWorktree: Record<string, TerminalTab[]>
  validTabIds: Set<string>
}

export function buildWorkspaceTerminalRowPlan(
  session: WorkspaceSessionState,
  validWorktreeIds: ReadonlySet<string>,
  options?: HydrateWorkspaceSessionOptions
): WorkspaceTerminalRowPlan {
  // Remote wire rows are authoritative independently of locally persisted unified tabs.
  const remoteSnapshotWorkspaceKeys = new Set(
    options?.directSshAuthority ? (options.replaceWorkspaceKeys ?? []) : []
  )
  const rowHydrationByWorktree = Object.entries(session.tabsByWorktree)
    .filter(([worktreeId]) => validWorktreeIds.has(worktreeId))
    .map(
      ([worktreeId, tabs]) =>
        [
          worktreeId,
          hydrateWorkspaceTerminalRows(session, worktreeId, tabs, {
            rowsFromRemoteSnapshot: remoteSnapshotWorkspaceKeys.has(worktreeId)
          })
        ] as const
    )
  const tabsByWorktree: Record<string, TerminalTab[]> = Object.fromEntries(
    rowHydrationByWorktree
      .map(([worktreeId, hydration]) => [worktreeId, hydration.rows] as const)
      .filter(
        ([worktreeId, tabs]) => tabs.length > 0 || session.tabsByWorktree[worktreeId]?.length === 0
      )
  )
  const releasedPtyIdsByTabId = new Map<string, Set<string>>(
    rowHydrationByWorktree.flatMap(([, hydration]) => [...hydration.releasedPtyIdsByTabId])
  )
  const reconnectPtyIdByRetainedTabId = new Map<string, string>(
    rowHydrationByWorktree.flatMap(([, hydration]) => [...hydration.reconnectPtyIdByRetainedTabId])
  )
  const canonicalTabIdBySubsumedTabId = new Map<string, string>(
    rowHydrationByWorktree.flatMap(([, hydration]) => [...hydration.canonicalTabIdBySubsumedTabId])
  )
  const validTabIds = new Set(
    Object.values(tabsByWorktree)
      .flat()
      .map((tab) => tab.id)
  )
  let sleepingAgentSessionsByPaneKey = Object.fromEntries(
    Object.entries(session.sleepingAgentSessionsByPaneKey ?? {}).filter(([, record]) =>
      validWorktreeIds.has(record.worktreeId)
    )
  )

  // Dropped rows never reach retirement, so remove their otherwise-stranded sleeping records.
  for (const [, hydration] of rowHydrationByWorktree) {
    for (const tabId of [...hydration.subsumedTabIds, ...hydration.invalidTabIds]) {
      sleepingAgentSessionsByPaneKey = removeSleepingAgentSessionsForTab(
        sleepingAgentSessionsByPaneKey,
        tabId
      )
    }
  }
  // Released leaves transferred to canonical rows and must not retain a duplicate sleeping owner.
  const releasedPaneKeys = new Set<string>(
    [...releasedPtyIdsByTabId].flatMap(([tabId, releasedPtyIds]) =>
      collectReleasedLeafIds(session.terminalLayoutsByTabId[tabId], releasedPtyIds)
        .filter(isTerminalLeafId)
        .map((leafId) => makePaneKey(tabId, leafId))
    )
  )
  if (releasedPaneKeys.size > 0) {
    sleepingAgentSessionsByPaneKey = Object.fromEntries(
      Object.entries(sleepingAgentSessionsByPaneKey).filter(
        ([paneKey]) => !releasedPaneKeys.has(paneKey)
      )
    )
  }

  return {
    canonicalTabIdBySubsumedTabId,
    reconnectPtyIdByRetainedTabId,
    releasedPtyIdsByTabId,
    sleepingAgentSessionsByPaneKey,
    tabsByWorktree,
    validTabIds
  }
}
