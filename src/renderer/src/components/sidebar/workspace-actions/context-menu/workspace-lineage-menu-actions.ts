import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectAwakeBrowserTabsByWorktree } from '@/components/sidebar/workspace-actions/sleep/browser-tab-sleep'
import { getDeleteStateForWorktreeHost } from '../deletion/worktree-delete-state-host-match'
import { tabHasLivePty } from '../../../../../../shared/tab-has-live-pty'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Tab } from '../../../../../../shared/tab-types'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { StructuredChatSleptAtByPaneKey } from '@/store/slices/agent-status/structured-chat-slept-at'
import { getWorkspaceDeleteLineage } from '../deletion/workspace-delete-lineage'

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

const EMPTY_IDS: readonly string[] = []

function selectWorkspaceActivity(state: AppState): WorkspaceActivityMaps {
  const browserTabsByWorktree = selectAwakeBrowserTabsByWorktree(state)
  return {
    tabsByWorktree: state.tabsByWorktree,
    ptyIdsByTabId: state.ptyIdsByTabId,
    browserTabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    structuredChatSleptAtByPaneKey: state.structuredChatSleptAtByPaneKey
  }
}

/**
 * Which of `worktrees` have something Sleep would close, and which are being deleted, as id lists
 * that keep their identity while unchanged. An open menu must not subscribe to the whole activity
 * and delete maps: agents, tabs and PTYs anywhere write them many times a second, and each write
 * re-rendered the whole menu under the pointer. Closed menus select a shared empty list.
 */
export function useWorkspaceMenuActivity(
  enabled: boolean,
  worktrees: readonly Worktree[]
): { sleepableIds: readonly string[]; deletingIds: readonly string[] } {
  const sleepableIds = useAppStore(
    useShallow((state) => {
      if (!enabled) {
        return EMPTY_IDS
      }
      const activity = selectWorkspaceActivity(state)
      return worktrees
        .filter((item) => hasSleepableWorkspaceActivity(item.id, activity))
        .map((item) => item.id)
    })
  )
  const deletingIds = useAppStore(
    useShallow((state) =>
      enabled
        ? worktrees
            .filter(
              (item) =>
                getDeleteStateForWorktreeHost(item, state.deleteStateByWorktreeId)?.isDeleting
            )
            .map((item) => item.id)
        : EMPTY_IDS
    )
  )
  return { sleepableIds, deletingIds }
}
