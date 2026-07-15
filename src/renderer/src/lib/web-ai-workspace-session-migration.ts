import { WEB_AI_BROWSER_WORKSPACE_ID, getWebAiAccountWorkspaceId } from '../../../shared/constants'
import type { WebAiAccount, WorkspaceSessionState } from '../../../shared/types'
import { webAiAccountMatchesWorkspace } from '../../../shared/web-ai-accounts'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  hasLegacyWebAiWorkspaceState,
  omitLegacyWebAiWorkspaceKey,
  removeLegacyWebAiTerminalState
} from './web-ai-workspace-session-legacy-state'
import {
  migrateLegacyWebAiTabTopology,
  type LegacyWebAiAccountMigration
} from './web-ai-workspace-session-topology'

/**
 * Upgrades the prototype's shared Web AI workspace into one workspace per
 * account. Why: all slices must hydrate the same re-keyed topology or active
 * pointers and split groups diverge before the browser slice can repair them.
 */
export function migrateLegacyWebAiWorkspaceSession(
  session: WorkspaceSessionState,
  accounts: readonly WebAiAccount[]
): WorkspaceSessionState {
  if (!hasLegacyWebAiWorkspaceState(session)) {
    return session
  }

  const accountById = new Map(accounts.map((account) => [account.id, account] as const))
  const legacyWorkspaces = session.browserTabsByWorktree?.[WEB_AI_BROWSER_WORKSPACE_ID] ?? []
  const targetByLegacyWorkspaceId = new Map<string, string>()
  const migrationsByAccountId = new Map<string, LegacyWebAiAccountMigration>()
  for (const workspace of legacyWorkspaces) {
    const account = workspace.webAiAccountId ? accountById.get(workspace.webAiAccountId) : undefined
    if (
      !account ||
      !webAiAccountMatchesWorkspace(account, workspace, WEB_AI_BROWSER_WORKSPACE_ID)
    ) {
      continue
    }
    const targetWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    targetByLegacyWorkspaceId.set(workspace.id, targetWorkspaceId)
    const existing = migrationsByAccountId.get(account.id)
    if (existing) {
      existing.workspaces.push(workspace)
    } else {
      migrationsByAccountId.set(account.id, { targetWorkspaceId, workspaces: [workspace] })
    }
  }

  let browserTabsByWorktree = omitLegacyWebAiWorkspaceKey(session.browserTabsByWorktree)
  let unifiedTabs = omitLegacyWebAiWorkspaceKey(session.unifiedTabs)
  let tabGroups = omitLegacyWebAiWorkspaceKey(session.tabGroups)
  let tabGroupLayouts = omitLegacyWebAiWorkspaceKey(session.tabGroupLayouts)
  let activeBrowserTabIdByWorktree = omitLegacyWebAiWorkspaceKey(
    session.activeBrowserTabIdByWorktree
  )
  let activeTabTypeByWorktree = omitLegacyWebAiWorkspaceKey(session.activeTabTypeByWorktree)
  let activeGroupIdByWorktree = omitLegacyWebAiWorkspaceKey(session.activeGroupIdByWorktree)
  let browserPagesByWorkspace = session.browserPagesByWorkspace
    ? { ...session.browserPagesByWorkspace }
    : undefined

  const migratedTargetIds = new Set<string>()
  for (const migration of migrationsByAccountId.values()) {
    const targetHasAuthoritativeState =
      (browserTabsByWorktree?.[migration.targetWorkspaceId]?.length ?? 0) > 0 ||
      (unifiedTabs?.[migration.targetWorkspaceId]?.length ?? 0) > 0 ||
      (tabGroups?.[migration.targetWorkspaceId]?.length ?? 0) > 0
    if (targetHasAuthoritativeState) {
      continue
    }
    migratedTargetIds.add(migration.targetWorkspaceId)
    const migratedWorkspaces = migration.workspaces.map((workspace) => ({
      ...workspace,
      worktreeId: migration.targetWorkspaceId
    }))
    browserTabsByWorktree = {
      ...browserTabsByWorktree,
      [migration.targetWorkspaceId]: migratedWorkspaces
    }
    for (const workspace of migration.workspaces) {
      const pages = session.browserPagesByWorkspace?.[workspace.id] ?? []
      if (pages.length > 0) {
        browserPagesByWorkspace = {
          ...browserPagesByWorkspace,
          [workspace.id]: pages.map((page) => ({
            ...page,
            worktreeId: migration.targetWorkspaceId
          }))
        }
      }
    }

    const topology = migrateLegacyWebAiTabTopology(session, migration)
    if (topology.tabs.length > 0) {
      unifiedTabs = { ...unifiedTabs, [migration.targetWorkspaceId]: topology.tabs }
    }
    if (topology.groups.length > 0) {
      tabGroups = { ...tabGroups, [migration.targetWorkspaceId]: topology.groups }
    }
    if (topology.layout) {
      tabGroupLayouts = {
        ...tabGroupLayouts,
        [migration.targetWorkspaceId]: topology.layout
      }
    }
    activeBrowserTabIdByWorktree = {
      ...activeBrowserTabIdByWorktree,
      [migration.targetWorkspaceId]: topology.activeBrowserWorkspaceId
    }
    activeTabTypeByWorktree = {
      ...activeTabTypeByWorktree,
      [migration.targetWorkspaceId]: 'browser'
    }
    if (topology.activeGroupId) {
      activeGroupIdByWorktree = {
        ...activeGroupIdByWorktree,
        [migration.targetWorkspaceId]: topology.activeGroupId
      }
    }
  }

  if (browserPagesByWorkspace) {
    for (const [workspaceId, pages] of Object.entries(browserPagesByWorkspace)) {
      const targetWorkspaceId = targetByLegacyWorkspaceId.get(workspaceId)
      if (targetWorkspaceId && migratedTargetIds.has(targetWorkspaceId)) {
        continue
      }
      const retainedPages = pages.filter((page) => page.worktreeId !== WEB_AI_BROWSER_WORKSPACE_ID)
      if (retainedPages.length > 0) {
        browserPagesByWorkspace[workspaceId] = retainedPages
      } else {
        delete browserPagesByWorkspace[workspaceId]
      }
    }
  }

  const legacyWasActive =
    session.activeWorktreeId === WEB_AI_BROWSER_WORKSPACE_ID ||
    session.activeWorkspaceKey === worktreeWorkspaceKey(WEB_AI_BROWSER_WORKSPACE_ID)
  const legacyActiveBrowserId =
    session.activeBrowserTabIdByWorktree?.[WEB_AI_BROWSER_WORKSPACE_ID] ?? null
  const activeTargetId =
    (legacyActiveBrowserId && targetByLegacyWorkspaceId.get(legacyActiveBrowserId)) ||
    (session.activeTabId
      ? targetByLegacyWorkspaceId.get(
          session.unifiedTabs?.[WEB_AI_BROWSER_WORKSPACE_ID]?.find(
            (tab) => tab.id === session.activeTabId
          )?.entityId ?? ''
        )
      : null) ||
    migrationsByAccountId.values().next().value?.targetWorkspaceId ||
    null
  const activeBrowserId = activeTargetId
    ? (activeBrowserTabIdByWorktree?.[activeTargetId] ??
      browserTabsByWorktree?.[activeTargetId]?.[0]?.id ??
      null)
    : null
  const activeGroupId = activeTargetId ? activeGroupIdByWorktree?.[activeTargetId] : null
  const activeUnifiedTabId = activeTargetId
    ? ((session.activeTabId &&
      unifiedTabs?.[activeTargetId]?.some((tab) => tab.id === session.activeTabId)
        ? session.activeTabId
        : undefined) ??
      unifiedTabs?.[activeTargetId]?.find((tab) => tab.entityId === activeBrowserId)?.id ??
      (activeGroupId
        ? tabGroups?.[activeTargetId]?.find((group) => group.id === activeGroupId)?.activeTabId
        : null) ??
      null)
    : null
  const legacyVisit = session.lastVisitedAtByWorktreeId?.[WEB_AI_BROWSER_WORKSPACE_ID]
  let lastVisitedAtByWorktreeId = omitLegacyWebAiWorkspaceKey(session.lastVisitedAtByWorktreeId)
  if (
    activeTargetId &&
    legacyVisit != null &&
    lastVisitedAtByWorktreeId?.[activeTargetId] == null
  ) {
    lastVisitedAtByWorktreeId = {
      ...lastVisitedAtByWorktreeId,
      [activeTargetId]: legacyVisit
    }
  }
  const legacyTerminalState = removeLegacyWebAiTerminalState(session)

  return {
    ...session,
    ...legacyTerminalState,
    activeRepoId: legacyWasActive ? null : session.activeRepoId,
    activeWorktreeId: legacyWasActive ? activeTargetId : session.activeWorktreeId,
    activeWorkspaceKey: legacyWasActive
      ? activeTargetId
        ? worktreeWorkspaceKey(activeTargetId)
        : null
      : session.activeWorkspaceKey,
    activeTabId: legacyWasActive ? activeUnifiedTabId : session.activeTabId,
    activeWorktreeIdsOnShutdown: session.activeWorktreeIdsOnShutdown?.filter(
      (workspaceId) => workspaceId !== WEB_AI_BROWSER_WORKSPACE_ID
    ),
    openFilesByWorktree: omitLegacyWebAiWorkspaceKey(session.openFilesByWorktree),
    activeFileIdByWorktree: omitLegacyWebAiWorkspaceKey(session.activeFileIdByWorktree),
    browserTabsByWorktree,
    browserPagesByWorkspace,
    activeBrowserTabIdByWorktree,
    activeTabTypeByWorktree,
    activeTabIdByWorktree: omitLegacyWebAiWorkspaceKey(session.activeTabIdByWorktree),
    unifiedTabs,
    tabGroups,
    tabGroupLayouts,
    activeGroupIdByWorktree,
    lastVisitedAtByWorktreeId,
    defaultTerminalTabsAppliedByWorktreeId: omitLegacyWebAiWorkspaceKey(
      session.defaultTerminalTabsAppliedByWorktreeId
    ),
    sleepingAgentSessionsByPaneKey: session.sleepingAgentSessionsByPaneKey
      ? Object.fromEntries(
          Object.entries(session.sleepingAgentSessionsByPaneKey).filter(
            ([, record]) => record.worktreeId !== WEB_AI_BROWSER_WORKSPACE_ID
          )
        )
      : undefined
  }
}
