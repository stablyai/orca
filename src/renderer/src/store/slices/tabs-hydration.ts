import type { Tab, TabGroup, WorkspaceSessionState } from '../../../../shared/types'

type HydratedTabState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
}

function hydrateUnifiedFormat(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>
): HydratedTabState {
  const tabsByWorktree: Record<string, Tab[]> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const activeGroupIdByWorktree: Record<string, string> = {}

  for (const [worktreeId, tabs] of Object.entries(session.unifiedTabs!)) {
    if (!validWorktreeIds.has(worktreeId)) {
      continue
    }
    if (tabs.length === 0) {
      continue
    }
    tabsByWorktree[worktreeId] = [...tabs].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt
    )
  }

  for (const [worktreeId, groups] of Object.entries(session.tabGroups!)) {
    if (!validWorktreeIds.has(worktreeId)) {
      continue
    }
    if (groups.length === 0) {
      continue
    }

    const validTabIds = new Set((tabsByWorktree[worktreeId] ?? []).map((t) => t.id))
    const validatedGroups = groups.map((g) => ({
      ...g,
      tabOrder: g.tabOrder.filter((tid) => validTabIds.has(tid)),
      activeTabId: g.activeTabId && validTabIds.has(g.activeTabId) ? g.activeTabId : null
    }))

    groupsByWorktree[worktreeId] = validatedGroups
    activeGroupIdByWorktree[worktreeId] = validatedGroups[0].id
  }

  return { unifiedTabsByWorktree: tabsByWorktree, groupsByWorktree, activeGroupIdByWorktree }
}

function hydrateLegacyFormat(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>
): HydratedTabState {
  const tabsByWorktree: Record<string, Tab[]> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const activeGroupIdByWorktree: Record<string, string> = {}

  for (const worktreeId of validWorktreeIds) {
    const terminalTabs = session.tabsByWorktree[worktreeId] ?? []
    const editorFiles = session.openFilesByWorktree?.[worktreeId] ?? []

    if (terminalTabs.length === 0 && editorFiles.length === 0) {
      continue
    }

    const groupId = globalThis.crypto.randomUUID()
    const tabs: Tab[] = []
    const tabOrder: string[] = []

    for (const tt of terminalTabs) {
      tabs.push({
        id: tt.id,
        groupId,
        worktreeId,
        contentType: 'terminal',
        label: tt.title,
        customLabel: tt.customTitle,
        color: tt.color,
        sortOrder: tt.sortOrder,
        createdAt: tt.createdAt,
        isPreview: false,
        isPinned: false
      })
      tabOrder.push(tt.id)
    }

    for (const ef of editorFiles) {
      tabs.push({
        id: ef.filePath,
        groupId,
        worktreeId,
        contentType: 'editor',
        label: ef.relativePath,
        customLabel: null,
        color: null,
        sortOrder: tabs.length,
        createdAt: Date.now(),
        isPreview: ef.isPreview,
        isPinned: false
      })
      tabOrder.push(ef.filePath)
    }

    const activeTabType = session.activeTabTypeByWorktree?.[worktreeId] ?? 'terminal'
    let activeTabId: string | null = null
    if (activeTabType === 'editor') {
      activeTabId = session.activeFileIdByWorktree?.[worktreeId] ?? null
    } else if (session.activeTabId && terminalTabs.some((t) => t.id === session.activeTabId)) {
      activeTabId = session.activeTabId
    }
    if (activeTabId && !tabs.some((t) => t.id === activeTabId)) {
      activeTabId = tabs[0]?.id ?? null
    }

    tabsByWorktree[worktreeId] = tabs
    groupsByWorktree[worktreeId] = [{ id: groupId, worktreeId, activeTabId, tabOrder }]
    activeGroupIdByWorktree[worktreeId] = groupId
  }

  return { unifiedTabsByWorktree: tabsByWorktree, groupsByWorktree, activeGroupIdByWorktree }
}

export function buildHydratedTabState(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>
): HydratedTabState {
  if (session.unifiedTabs && session.tabGroups) {
    return hydrateUnifiedFormat(session, validWorktreeIds)
  }
  return hydrateLegacyFormat(session, validWorktreeIds)
}
