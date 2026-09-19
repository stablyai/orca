import type { WorkspaceSessionState } from './workspace-session-state-types'
import { parseWorkspaceSession } from './workspace-session-schema'

export function parseOrcadMigrationDormantWorkspaceSession(value: unknown): WorkspaceSessionState {
  const parsed = parseWorkspaceSession(value)
  if (!parsed.ok) {
    throw new Error(`orcad_migration_dormant_workspace_session_invalid:${parsed.error}`)
  }
  return parsed.value
}

export function assertOrcadMigrationDormantWorkspaceSessionReferences(args: {
  session: WorkspaceSessionState
  owns: (ownerKey: string) => boolean
  repositoryIds: ReadonlySet<string>
}): void {
  const { session } = args
  const terminalTabIds = new Set<string>()
  const browserWorkspaceIds = new Set<string>()
  const browserWorkspaceOwnerById = new Map<string, string>()
  const clientHostedBrowserPageIds = new Set<string>()
  const clientHostedBrowserPageOwnerById = new Map<string, string>()
  const unifiedTabIds = new Set<string>()
  const tabGroupIds = new Set<string>()
  for (const [ownerKey, tabs] of Object.entries(session.tabsByWorktree)) {
    assertOwner(args.owns, ownerKey)
    for (const tab of tabs) {
      assertOwner(args.owns, tab.worktreeId)
      if (tab.ptyId) {
        throw new Error('orcad_migration_dormant_workspace_session_pty_invalid')
      }
      addUniqueSessionId(terminalTabIds, tab.id)
    }
  }
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    assertOwner(args.owns, ownerKey)
    for (const file of files) {
      assertOwner(args.owns, file.worktreeId)
      if (file.externalSshTargetId) {
        throw new Error('orcad_migration_dormant_workspace_session_external_file_invalid')
      }
      if (file.runtimeEnvironmentId) {
        throw new Error('orcad_migration_dormant_workspace_session_file_runtime_invalid')
      }
    }
  }
  const markdownFileIdCounts = new Map<string, number>()
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    if (!args.owns(ownerKey)) {
      continue
    }
    for (const file of files) {
      for (const fileId of [
        file.filePath,
        ownedEditorFileId(file.filePath, ownerKey, file.runtimeEnvironmentId)
      ]) {
        markdownFileIdCounts.set(fileId, (markdownFileIdCounts.get(fileId) ?? 0) + 1)
      }
    }
  }
  for (const fileId of Object.keys(session.markdownFrontmatterVisible ?? {})) {
    if (markdownFileIdCounts.get(fileId) !== 1) {
      throw new Error('orcad_migration_dormant_workspace_session_markdown_scope_invalid')
    }
  }
  for (const [ownerKey, workspaces] of Object.entries(session.browserTabsByWorktree ?? {})) {
    assertOwner(args.owns, ownerKey)
    for (const workspace of workspaces) {
      assertOwner(args.owns, workspace.worktreeId)
      if (workspace.sessionProfileId || workspace.sessionPartition) {
        throw new Error('orcad_migration_dormant_workspace_session_browser_profile_invalid')
      }
      addUniqueSessionId(browserWorkspaceIds, workspace.id)
      browserWorkspaceOwnerById.set(workspace.id, ownerKey)
    }
  }
  for (const [workspaceId, pages] of Object.entries(session.browserPagesByWorkspace ?? {})) {
    if (!browserWorkspaceIds.has(workspaceId)) {
      throw new Error('orcad_migration_dormant_workspace_session_browser_page_scope_invalid')
    }
    pages.forEach((page) => assertOwner(args.owns, page.worktreeId))
  }
  for (const [ownerKey, pages] of Object.entries(
    session.clientHostedBrowserPagesByWorktree ?? {}
  )) {
    assertOwner(args.owns, ownerKey)
    pages.forEach((page) => {
      if (
        !browserWorkspaceIds.has(page.workspaceId) ||
        browserWorkspaceOwnerById.get(page.workspaceId) !== ownerKey
      ) {
        throw new Error('orcad_migration_dormant_workspace_session_client_page_scope_invalid')
      }
      addUniqueSessionId(clientHostedBrowserPageIds, page.browserPageId)
      clientHostedBrowserPageOwnerById.set(page.browserPageId, ownerKey)
    })
  }
  const closeIntentKeys = new Set<string>()
  for (const [environmentId, intents] of Object.entries(
    session.clientHostedBrowserCloseIntentsByEnvironment ?? {}
  )) {
    if (!environmentId) {
      throw new Error('orcad_migration_dormant_workspace_session_close_intent_scope_invalid')
    }
    for (const intent of intents) {
      assertOwner(args.owns, intent.worktreeId)
      const ownerKey = clientHostedBrowserPageOwnerById.get(intent.browserPageId)
      if (!clientHostedBrowserPageIds.has(intent.browserPageId) || ownerKey !== intent.worktreeId) {
        throw new Error('orcad_migration_dormant_workspace_session_close_intent_scope_invalid')
      }
      const key = `${environmentId}\0${intent.browserPageId}\0${intent.worktreeId}`
      if (closeIntentKeys.has(key)) {
        throw new Error('orcad_migration_dormant_workspace_session_identity_duplicate')
      }
      closeIntentKeys.add(key)
    }
  }
  for (const [ownerKey, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    assertOwner(args.owns, ownerKey)
    for (const tab of tabs) {
      assertOwner(args.owns, tab.worktreeId)
      if (tab.contentType === 'terminal') {
        // Unified terminal tabs normally mirror tabsByWorktree, but a session written during
        // model rollout can contain only this representation. Layouts still belong to it.
        terminalTabIds.add(tab.id)
        terminalTabIds.add(tab.entityId)
      }
      addUniqueSessionId(unifiedTabIds, tab.id)
      if (tab.executionHostId !== undefined && tab.executionHostId !== 'local') {
        throw new Error('orcad_migration_dormant_workspace_session_host_invalid')
      }
    }
  }
  for (const [ownerKey, groups] of Object.entries(session.tabGroups ?? {})) {
    assertOwner(args.owns, ownerKey)
    groups.forEach((group) => {
      assertOwner(args.owns, group.worktreeId)
      addUniqueSessionId(tabGroupIds, group.id)
    })
  }
  assertOwnerRecordKeys(args.owns, [
    session.activeFileIdByWorktree,
    session.activeBrowserTabIdByWorktree,
    session.activeTabTypeByWorktree,
    session.activeTabIdByWorktree,
    session.tabGroupLayouts,
    session.activeGroupIdByWorktree,
    session.lastVisitedAtByWorktreeId,
    session.defaultTerminalTabsAppliedByWorktreeId
  ])
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId)) {
    if (
      !terminalTabIds.has(tabId) ||
      Object.keys(layout.ptyIdsByLeafId ?? {}).length > 0 ||
      Object.keys(layout.buffersByLeafId ?? {}).length > 0
    ) {
      throw new Error('orcad_migration_dormant_workspace_session_layout_invalid')
    }
  }
  if (session.activeRepoId !== null && !args.repositoryIds.has(session.activeRepoId)) {
    throw new Error('orcad_migration_dormant_workspace_session_focus_scope_invalid')
  }
  if (session.activeWorktreeId !== null) {
    assertOwner(args.owns, session.activeWorktreeId)
  }
  if (session.activeWorkspaceKey != null) {
    assertOwner(args.owns, session.activeWorkspaceKey)
  }
  if (
    session.activeWorkspaceExecutionHostId !== undefined &&
    session.activeWorkspaceExecutionHostId !== null &&
    session.activeWorkspaceExecutionHostId !== 'local'
  ) {
    throw new Error('orcad_migration_dormant_workspace_session_host_invalid')
  }
  if (session.activeTabId !== null && !terminalTabIds.has(session.activeTabId)) {
    throw new Error('orcad_migration_dormant_workspace_session_focus_scope_invalid')
  }
  for (const entry of Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})) {
    assertOwner(args.owns, entry.worktreeId)
  }
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    assertOwner(args.owns, record.worktreeId)
    if (
      record.connectionId != null ||
      ('automaticResumeBlockedBy' in record && record.automaticResumeBlockedBy !== undefined)
    ) {
      throw new Error('orcad_migration_dormant_workspace_session_agent_authority_invalid')
    }
    if (
      (record.origin === 'quit' || record.origin === 'live') &&
      !paneBelongsToTerminalLayout(record, session, terminalTabIds)
    ) {
      throw new Error('orcad_migration_dormant_workspace_session_agent_pane_invalid')
    }
  }
  for (const repoId of Object.keys(session.terminalTopologyRevisionByRepoId ?? {})) {
    if (!args.repositoryIds.has(repoId)) {
      throw new Error('orcad_migration_dormant_workspace_session_topology_scope_invalid')
    }
  }
  if (
    (session.activeWorktreeIdsOnShutdown?.length ?? 0) > 0 ||
    (session.activeConnectionIdsAtShutdown?.length ?? 0) > 0 ||
    Object.keys(session.remoteSessionIdsByTabId ?? {}).length > 0 ||
    Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}).length > 0
  ) {
    throw new Error('orcad_migration_dormant_workspace_session_live_or_client_state_invalid')
  }
}

function ownedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeEnvironmentId?.trim() || 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}

function paneBelongsToTerminalLayout(
  record: NonNullable<WorkspaceSessionState['sleepingAgentSessionsByPaneKey']>[string],
  session: WorkspaceSessionState,
  tabIds: ReadonlySet<string>
): boolean {
  const separator = record.paneKey.lastIndexOf(':')
  if (separator < 1) {
    return false
  }
  const tabId = record.paneKey.slice(0, separator)
  const leafId = record.paneKey.slice(separator + 1)
  if ((record.tabId !== undefined && record.tabId !== tabId) || !tabIds.has(tabId)) {
    return false
  }
  return terminalLayoutContainsLeaf(session.terminalLayoutsByTabId[tabId]?.root, leafId)
}

function terminalLayoutContainsLeaf(
  node: WorkspaceSessionState['terminalLayoutsByTabId'][string]['root'] | undefined,
  leafId: string
): boolean {
  return Boolean(
    node &&
    (node.type === 'leaf'
      ? node.leafId === leafId
      : terminalLayoutContainsLeaf(node.first, leafId) ||
        terminalLayoutContainsLeaf(node.second, leafId))
  )
}

function assertOwnerRecordKeys(
  owns: (ownerKey: string) => boolean,
  records: (Record<string, unknown> | undefined)[]
): void {
  for (const record of records) {
    Object.keys(record ?? {}).forEach((ownerKey) => assertOwner(owns, ownerKey))
  }
}

function assertOwner(owns: (ownerKey: string) => boolean, ownerKey: string): void {
  if (!owns(ownerKey)) {
    throw new Error('orcad_migration_dormant_workspace_session_scope_invalid')
  }
}

function addUniqueSessionId(ids: Set<string>, id: string): void {
  if (ids.has(id)) {
    throw new Error('orcad_migration_dormant_workspace_session_identity_duplicate')
  }
  ids.add(id)
}
