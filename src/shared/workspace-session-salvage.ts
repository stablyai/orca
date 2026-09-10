import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  describeWorkspaceSessionError,
  safeParseWorkspaceSession,
  WORKSPACE_SESSION_UNVALIDATABLE
} from './workspace-session-schema'
import { collectSalvageDrops } from './zod-salvage'
import type { Tab, TabGroup, TabGroupLayoutNode } from './tab-types'
import { isWorkspaceKey, worktreeWorkspaceKey } from './workspace-scope'

export type SalvagedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState; droppedPaths: string[]; droppedCount: number }
  | { ok: false; error: string }

export type WorkspaceTabState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
}

function maestroTabId(executionHostId: string, workspaceKey: string): string {
  return `workspace-maestro:${encodeURIComponent(executionHostId)}:${encodeURIComponent(workspaceKey)}`
}

/** Restores the one-per-workspace Maestro system-tab invariant without touching resources. */
export function normalizeWorkspaceMaestroTabs(
  state: WorkspaceTabState,
  workspaceIds: ReadonlySet<string>,
  activeWorkspace?: { key: string | null; executionHostId: string | null }
): WorkspaceTabState {
  const next: WorkspaceTabState = {
    unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree },
    groupsByWorktree: { ...state.groupsByWorktree },
    activeGroupIdByWorktree: { ...state.activeGroupIdByWorktree },
    layoutByWorktree: { ...state.layoutByWorktree }
  }

  for (const workspaceId of workspaceIds) {
    const workspaceKey = isWorkspaceKey(workspaceId)
      ? workspaceId
      : worktreeWorkspaceKey(workspaceId)
    const tabs = next.unifiedTabsByWorktree[workspaceId] ?? []
    const groups = next.groupsByWorktree[workspaceId] ?? []
    const primaryGroup: TabGroup = groups[0] ?? {
      id: `workspace-maestro-group:${encodeURIComponent(workspaceId)}`,
      worktreeId: workspaceId,
      activeTabId: null,
      tabOrder: []
    }
    const activeHost =
      activeWorkspace?.key === workspaceKey ? activeWorkspace.executionHostId : null
    const persistedHost = tabs.find(
      (tab) => tab.contentType === 'maestro' && tab.maestroWorkspaceKey === workspaceKey
    )?.maestroExecutionHostId
    const executionHostId = activeHost ?? persistedHost ?? 'local'
    const exactCandidates = tabs.filter(
      (tab) =>
        tab.contentType === 'maestro' &&
        tab.maestroExecutionHostId === executionHostId &&
        tab.maestroWorkspaceKey === workspaceKey
    )
    const preferred =
      exactCandidates.find(
        (tab) => tab.groupId === primaryGroup.id && primaryGroup.tabOrder[0] === tab.id
      ) ?? exactCandidates[0]
    const id = preferred?.id ?? maestroTabId(executionHostId, workspaceKey)
    const duplicateIds = new Set(
      tabs.filter((tab) => tab.contentType === 'maestro').map((tab) => tab.id)
    )
    const activeGroup = groups.find(
      (group) => group.id === next.activeGroupIdByWorktree[workspaceId]
    )
    const activeWasMaestro =
      activeGroup?.activeTabId !== null && duplicateIds.has(activeGroup?.activeTabId ?? '')
    const survivor: Tab = {
      ...preferred,
      id,
      entityId: id,
      groupId: primaryGroup.id,
      worktreeId: workspaceId,
      contentType: 'maestro',
      label: 'Maestro',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: preferred?.createdAt ?? 0,
      isPreview: false,
      isPinned: true,
      systemRole: 'workspace-maestro',
      maestroExecutionHostId: executionHostId,
      maestroWorkspaceKey: workspaceKey
    }
    const ordinaryTabs = tabs.filter((tab) => tab.contentType !== 'maestro')
    const ordinaryIds = new Set(ordinaryTabs.map((tab) => tab.id))
    const normalizedGroups = [
      primaryGroup,
      ...groups.filter((group) => group.id !== primaryGroup.id)
    ].map((group) => {
      const ordinaryOrder = group.tabOrder.filter((tabId) => ordinaryIds.has(tabId))
      const activeWasMaestro = group.activeTabId !== null && duplicateIds.has(group.activeTabId)
      return {
        ...group,
        activeTabId:
          activeWasMaestro && group.id === primaryGroup.id
            ? id
            : group.activeTabId && ordinaryIds.has(group.activeTabId)
              ? group.activeTabId
              : group.id === primaryGroup.id
                ? id
                : (ordinaryOrder[0] ?? null),
        tabOrder: group.id === primaryGroup.id ? [id, ...ordinaryOrder] : ordinaryOrder,
        recentTabIds: [
          ...new Set([
            ...(group.id === primaryGroup.id && activeWasMaestro ? [id] : []),
            ...(group.recentTabIds ?? []).filter((tabId) => ordinaryIds.has(tabId))
          ])
        ]
      }
    })
    next.unifiedTabsByWorktree[workspaceId] = [
      survivor,
      ...ordinaryTabs.map((tab) => ({
        ...tab,
        sortOrder:
          normalizedGroups.find((group) => group.id === tab.groupId)?.tabOrder.indexOf(tab.id) ??
          tab.sortOrder
      }))
    ]
    next.groupsByWorktree[workspaceId] = normalizedGroups
    next.activeGroupIdByWorktree[workspaceId] = activeWasMaestro
      ? primaryGroup.id
      : normalizedGroups.some((group) => group.id === next.activeGroupIdByWorktree[workspaceId])
        ? next.activeGroupIdByWorktree[workspaceId]
        : primaryGroup.id
    next.layoutByWorktree[workspaceId] = next.layoutByWorktree[workspaceId] ?? {
      type: 'leaf',
      groupId: primaryGroup.id
    }
  }
  return next
}

/** Remove undefined keys that would shadow caller defaults during object spread. */
function withoutSalvagedAwayFields(session: WorkspaceSessionState): WorkspaceSessionState {
  return Object.fromEntries(
    Object.entries(session).filter(([, value]) => value !== undefined)
  ) as WorkspaceSessionState
}

/** Validate a session, preserving valid entries and reporting bounded repair diagnostics. */
export function parseWorkspaceSessionSalvaging(raw: unknown): SalvagedWorkspaceSession {
  const {
    value: result,
    droppedPaths,
    droppedCount
  } = collectSalvageDrops(() => safeParseWorkspaceSession(raw))
  if (!result) {
    return { ok: false, error: WORKSPACE_SESSION_UNVALIDATABLE }
  }
  if (!result.success) {
    return { ok: false, error: describeWorkspaceSessionError(result.error) }
  }
  return { ok: true, value: withoutSalvagedAwayFields(result.data), droppedPaths, droppedCount }
}
