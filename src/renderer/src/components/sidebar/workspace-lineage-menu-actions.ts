import { useMemo } from 'react'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Tab } from '../../../../shared/tab-types'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  isChatExplicitlySlept,
  type ExplicitlySleptChatsByWorkspace
} from '../../../../shared/workspace-chat-sleep'
import type { WorkspaceSleepTarget } from './sleep-worktree-flow'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner
} from '@/lib/worktree-runtime-owner-index'
import { getFolderWorkspaceHostId } from './folder-workspace-host-id'

type WorkspaceActivityMaps = {
  tabsByWorktree: Record<string, { id: string }[]>
  ptyIdsByTabId: Record<string, string[]>
  browserTabsByWorktree: Record<string, { id: string }[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  agentStatusByPaneKey: Record<string, { structuredHostOwned?: true }>
  explicitlySleptChatsByWorkspace: ExplicitlySleptChatsByWorkspace
  chatOwnerState: WorktreeRuntimeOwnerState
}

export type WorkspaceLineageMenuActions = {
  descendants: Worktree[]
  targets: Worktree[]
  sleepableTargets: Worktree[]
}

export function hasSleepableWorkspaceActivity(
  target: WorkspaceSleepTarget,
  {
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    unifiedTabsByWorktree,
    agentStatusByPaneKey,
    explicitlySleptChatsByWorkspace,
    chatOwnerState
  }: WorkspaceActivityMaps
): boolean {
  const worktreeId = typeof target === 'string' ? target : target.id
  const tabs = tabsByWorktree[worktreeId] ?? []
  const scope = parseWorkspaceKey(worktreeId)
  const explicitHost =
    typeof target === 'string'
      ? undefined
      : (target.executionHostId ??
        (scope?.type === 'folder' && target.runtimeOwnerEnvironmentId?.trim()
          ? toRuntimeExecutionHostId(target.runtimeOwnerEnvironmentId.trim())
          : target.hostId))
  const route = resolveWorktreeOperationRouteResult(chatOwnerState, worktreeId)
  const folder =
    scope?.type === 'folder'
      ? findIndexedFolderWorkspaceOwner(
          chatOwnerState.folderWorkspaces,
          scope.folderWorkspaceId,
          parseExecutionHostId(explicitHost)?.id
        )
      : null
  const group = folder
    ? ((explicitHost
        ? findIndexedProjectGroupOwner(
            chatOwnerState.projectGroups,
            folder.projectGroupId,
            parseExecutionHostId(explicitHost)?.id
          )
        : null) ??
      findIndexedProjectGroupOwner(chatOwnerState.projectGroups, folder.projectGroupId))
    : null
  const selectedHost =
    scope?.type === 'folder'
      ? folder
        ? target && typeof target !== 'string' && target.executionHostId
          ? target.executionHostId
          : getFolderWorkspaceHostId(
              folder,
              group ?? { connectionId: null, executionHostId: null },
              parseExecutionHostId(
                chatOwnerState.restoredRuntimeHostIdByWorkspaceSessionKey?.[worktreeId]
              )?.id ?? LOCAL_EXECUTION_HOST_ID
            )
        : null
      : route.kind === 'resolved'
        ? (explicitHost ?? route.route.executionHostId)
        : (explicitHost ?? null)
  const hostId = parseExecutionHostId(selectedHost)?.id
  return (
    tabs.some((tab) => tabHasLivePty(ptyIdsByTabId, tab.id)) ||
    (browserTabsByWorktree[worktreeId] ?? []).length > 0 ||
    // A chat counts while its host holds its process, or until an explicit Sleep records it
    // stopped, so an idle-ended chat can still be slept (and hidden) on purpose.
    (unifiedTabsByWorktree[worktreeId] ?? []).some(
      (tab) =>
        isStructuredTab(tab) &&
        !!hostId &&
        (!tab.executionHostId || tab.executionHostId === hostId) &&
        (agentStatusByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)]
          ?.structuredHostOwned === true ||
          (tab.executionHostId === hostId &&
            !isChatExplicitlySlept(explicitlySleptChatsByWorkspace, tab)))
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
      hasSleepableWorkspaceActivity(target, args.activity)
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
    explicitlySleptChatsByWorkspace,
    chatOwnerState
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
              explicitlySleptChatsByWorkspace,
              chatOwnerState
            }
          })
        : EMPTY_LINEAGE_MENU_ACTIONS,
    [
      agentStatusByPaneKey,
      browserTabsByWorktree,
      enabled,
      explicitlySleptChatsByWorkspace,
      lineageById,
      parent,
      ptyIdsByTabId,
      tabsByWorktree,
      unifiedTabsByWorktree,
      chatOwnerState,
      worktrees
    ]
  )
}
