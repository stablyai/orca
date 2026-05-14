import { getDefaultWorkspaceSession } from './constants'
import type { RemoteWorkspaceSession, RemoteWorkspaceTerminalTab } from './remote-workspace-types'
import type { TerminalTab, WorkspaceSessionState } from './types'
import { splitWorktreeId } from './worktree-id'

type ExportOptions = {
  isTargetWorktree: (worktreeId: string) => boolean
}

type ImportOptions = {
  resolveWorktreeId: (worktreePath: string) => string | null
}

function worktreePathFromId(worktreeId: string): string | null {
  return splitWorktreeId(worktreeId)?.worktreePath ?? null
}

function tabToRemote(tab: TerminalTab, worktreePath: string): RemoteWorkspaceTerminalTab {
  const { worktreeId: _worktreeId, pendingActivationSpawn: _pendingActivationSpawn, ...rest } = tab
  void _worktreeId
  void _pendingActivationSpawn
  return { ...rest, worktreePath }
}

function tabToLocal(tab: RemoteWorkspaceTerminalTab, worktreeId: string): TerminalTab {
  const { worktreePath: _worktreePath, ...rest } = tab
  void _worktreePath
  return { ...rest, worktreeId }
}

export function exportRemoteWorkspaceSession(
  session: WorkspaceSessionState,
  options: ExportOptions
): RemoteWorkspaceSession {
  const tabsByWorktreePath: Record<string, RemoteWorkspaceTerminalTab[]> = {}
  const terminalTabIds = new Set<string>()

  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree)) {
    if (!options.isTargetWorktree(worktreeId)) {
      continue
    }
    const worktreePath = worktreePathFromId(worktreeId)
    if (!worktreePath) {
      continue
    }
    tabsByWorktreePath[worktreePath] = tabs.map((tab) => {
      terminalTabIds.add(tab.id)
      return tabToRemote(tab, worktreePath)
    })
  }

  const activeWorktreePath =
    session.activeWorktreeId && options.isTargetWorktree(session.activeWorktreeId)
      ? worktreePathFromId(session.activeWorktreeId)
      : null

  const activeTabId =
    session.activeTabId && terminalTabIds.has(session.activeTabId) ? session.activeTabId : null

  const activeTabIdByWorktreePath: Record<string, string | null> = {}
  for (const [worktreeId, tabId] of Object.entries(session.activeTabIdByWorktree ?? {})) {
    if (!options.isTargetWorktree(worktreeId)) {
      continue
    }
    const worktreePath = worktreePathFromId(worktreeId)
    if (worktreePath) {
      activeTabIdByWorktreePath[worktreePath] = tabId && terminalTabIds.has(tabId) ? tabId : null
    }
  }

  const lastVisitedAtByWorktreePath: Record<string, number> = {}
  for (const [worktreeId, timestamp] of Object.entries(session.lastVisitedAtByWorktreeId ?? {})) {
    if (!options.isTargetWorktree(worktreeId)) {
      continue
    }
    const worktreePath = worktreePathFromId(worktreeId)
    if (worktreePath) {
      lastVisitedAtByWorktreePath[worktreePath] = timestamp
    }
  }

  return {
    activeWorktreePath,
    activeTabId,
    tabsByWorktreePath,
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(session.terminalLayoutsByTabId ?? {}).filter(([tabId]) =>
        terminalTabIds.has(tabId)
      )
    ),
    activeWorktreePathsOnShutdown: session.activeWorktreeIdsOnShutdown
      ?.filter(options.isTargetWorktree)
      .map(worktreePathFromId)
      .filter((path): path is string => Boolean(path)),
    activeTabIdByWorktreePath,
    remoteSessionIdsByTabId: session.remoteSessionIdsByTabId
      ? Object.fromEntries(
          Object.entries(session.remoteSessionIdsByTabId).filter(([tabId]) =>
            terminalTabIds.has(tabId)
          )
        )
      : undefined,
    lastVisitedAtByWorktreePath
  }
}

export function importRemoteWorkspaceSession(
  remote: RemoteWorkspaceSession,
  options: ImportOptions
): WorkspaceSessionState {
  const session = getDefaultWorkspaceSession()
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  const terminalTabIds = new Set<string>()
  const worktreeIdByPath = new Map<string, string>()
  const resolvePath = (worktreePath: string): string | null => {
    if (worktreeIdByPath.has(worktreePath)) {
      return worktreeIdByPath.get(worktreePath) ?? null
    }
    const worktreeId = options.resolveWorktreeId(worktreePath)
    if (worktreeId) {
      worktreeIdByPath.set(worktreePath, worktreeId)
    }
    return worktreeId
  }

  for (const [worktreePath, tabs] of Object.entries(remote.tabsByWorktreePath ?? {})) {
    const worktreeId = resolvePath(worktreePath)
    if (!worktreeId) {
      continue
    }
    tabsByWorktree[worktreeId] = tabs.map((tab) => {
      terminalTabIds.add(tab.id)
      return tabToLocal(tab, worktreeId)
    })
  }

  const activeWorktreeId = remote.activeWorktreePath ? resolvePath(remote.activeWorktreePath) : null

  const activeTabId =
    remote.activeTabId && terminalTabIds.has(remote.activeTabId) ? remote.activeTabId : null

  const activeTabIdByWorktree: Record<string, string | null> = {}
  for (const [worktreePath, tabId] of Object.entries(remote.activeTabIdByWorktreePath ?? {})) {
    const worktreeId = resolvePath(worktreePath)
    if (worktreeId) {
      activeTabIdByWorktree[worktreeId] = tabId && terminalTabIds.has(tabId) ? tabId : null
    }
  }

  const lastVisitedAtByWorktreeId: Record<string, number> = {}
  for (const [worktreePath, timestamp] of Object.entries(
    remote.lastVisitedAtByWorktreePath ?? {}
  )) {
    const worktreeId = resolvePath(worktreePath)
    if (worktreeId) {
      lastVisitedAtByWorktreeId[worktreeId] = timestamp
    }
  }

  return {
    ...session,
    activeRepoId: activeWorktreeId ? (splitWorktreeId(activeWorktreeId)?.repoId ?? null) : null,
    activeWorktreeId,
    activeTabId,
    tabsByWorktree,
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(remote.terminalLayoutsByTabId ?? {}).filter(([tabId]) =>
        terminalTabIds.has(tabId)
      )
    ),
    activeWorktreeIdsOnShutdown: remote.activeWorktreePathsOnShutdown
      ?.map((path) => worktreeIdByPath.get(path))
      .filter((id): id is string => Boolean(id)),
    activeTabIdByWorktree,
    remoteSessionIdsByTabId: remote.remoteSessionIdsByTabId
      ? Object.fromEntries(
          Object.entries(remote.remoteSessionIdsByTabId).filter(([tabId]) =>
            terminalTabIds.has(tabId)
          )
        )
      : undefined,
    lastVisitedAtByWorktreeId
  }
}
