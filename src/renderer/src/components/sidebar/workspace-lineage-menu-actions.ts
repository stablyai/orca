import { useMemo } from 'react'
import { tabHasLivePty } from '../../../../shared/tab-has-live-pty'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Tab } from '../../../../shared/tab-types'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { StructuredChatSleptAtByPaneKey } from '@/store/slices/structured-chat-slept-at'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'

type WorkspaceActivityMaps = {
  tabsByWorktree: Record<string, { id: string }[]>
  ptyIdsByTabId: Record<string, string[]>
  browserTabsByWorktree: Record<string, { id: string }[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  agentStatusByPaneKey: Record<string, { structuredHostOwned?: true }>
  structuredChatSleptAtByPaneKey: StructuredChatSleptAtByPaneKey
}

export type WorkspaceLineageMenuActions = {
  descendants: Worktree[]
  targets: Worktree[]
  sleepableTargets: Worktree[]
}

export function hasSleepableWorkspaceActivity(
  worktreeId: string,
  activity: WorkspaceActivityMaps
): boolean {
  const tabs = activity.tabsByWorktree[worktreeId] ?? []
  return (
    tabs.some((tab) => tabHasLivePty(activity.ptyIdsByTabId, tab.id)) ||
    (activity.browserTabsByWorktree[worktreeId] ?? []).length > 0 ||
    // An idle-ended chat still needs Sleep to hide it, even when its legacy tab has no host stamp.
    (activity.unifiedTabsByWorktree[worktreeId] ?? []).some(
      (tab) =>
        isStructuredTab(tab) &&
        (activity.agentStatusByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)]
          ?.structuredHostOwned === true ||
          activity.structuredChatSleptAtByPaneKey[
            structuredAgentSessionPaneKey(tab.id, tab.entityId)
          ] === null)
    )
  )
}

export function getWorkspaceLineageMenuActions(args: {
  parent: Worktree
  worktrees: readonly Worktree[]
  lineageById: Record<string, WorktreeLineage>
  activity: WorkspaceActivityMaps
}): WorkspaceLineageMenuActions {
  const { descendants } = getWorkspaceDeleteLineage(args.parent, args.worktrees, args.lineageById)
  const targets = [args.parent, ...descendants]
  return {
    descendants,
    targets,
    sleepableTargets: targets.filter((target) =>
      hasSleepableWorkspaceActivity(target.id, args.activity)
    )
  }
}

const EMPTY_LINEAGE_MENU_ACTIONS: WorkspaceLineageMenuActions = {
  descendants: [],
  targets: [],
  sleepableTargets: []
}

export function useWorkspaceLineageMenuActions(
  args: Parameters<typeof getWorkspaceLineageMenuActions>[0] & { enabled: boolean }
): WorkspaceLineageMenuActions {
  const { enabled, parent, worktrees, lineageById, activity } = args
  const {
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    unifiedTabsByWorktree,
    agentStatusByPaneKey,
    structuredChatSleptAtByPaneKey
  } = activity
  return useMemo(
    () =>
      enabled
        ? getWorkspaceLineageMenuActions({
            parent,
            worktrees,
            lineageById,
            activity: {
              tabsByWorktree,
              ptyIdsByTabId,
              browserTabsByWorktree,
              unifiedTabsByWorktree,
              agentStatusByPaneKey,
              structuredChatSleptAtByPaneKey
            }
          })
        : EMPTY_LINEAGE_MENU_ACTIONS,
    [
      agentStatusByPaneKey,
      browserTabsByWorktree,
      enabled,
      structuredChatSleptAtByPaneKey,
      lineageById,
      parent,
      ptyIdsByTabId,
      tabsByWorktree,
      unifiedTabsByWorktree,
      worktrees
    ]
  )
}
