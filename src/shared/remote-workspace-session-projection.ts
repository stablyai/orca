import { getDefaultWorkspaceSession } from './constants'
import type { RemoteWorkspaceSession, RemoteWorkspaceTerminalTab } from './remote-workspace-types'
import type { TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { splitWorktreeId } from './worktree/id'
import type { ExecutionHostId } from './execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from './worktree/host-qualified-identity'

type ExportOptions = {
  isTargetWorktree: (worktreeId: string, executionHostId?: ExecutionHostId) => boolean
}

type ImportOptions = {
  resolveWorktreeId: (worktreePath: string) => string | null
  /** Host owning the projected snapshot; absent preserves the legacy bare key. */
  executionHostId?: ExecutionHostId
  /**
   * Called for every host path carrying terminal tabs that `resolveWorktreeId` could not place.
   * An unplaceable path is `unverifiable` — the local catalog has not landed yet — never proof the
   * row is not ours, so callers must not treat such an import as an authoritative picture of the
   * host. See docs/reference/ssh-execution-boundary.md.
   */
  onUnplacedTerminalTabs?: (worktreePath: string, tabCount: number) => void
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
    // Why union rather than assignment: `worktreePathFromId` drops the repoId, so two local keys
    // for one host path — duplicate repo rows for the same remote checkout, which is the normal
    // state while a host catalog reconciles — collapse onto one entry here. Assignment let
    // whichever key came last win outright, and an empty twin published an empty tab list for a
    // workspace the user had panes open in (#15484). This projection is uploaded as a wholesale
    // replace-session, so a clobbered entry deletes those tabs from the host snapshot. The host has
    // one workspace at that path, so the union deduped by tab id is the only lossless answer. Same
    // collision the `Math.max` below folds for `lastVisitedAtByWorktreePath`.
    const merged = tabsByWorktreePath[worktreePath] ?? []
    const alreadyProjected = new Set(merged.map((tab) => tab.id))
    for (const tab of tabs) {
      if (alreadyProjected.has(tab.id)) {
        continue
      }
      alreadyProjected.add(tab.id)
      terminalTabIds.add(tab.id)
      merged.push(tabToRemote(tab, worktreePath))
    }
    tabsByWorktreePath[worktreePath] = merged
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
      // Same path collision as the tab lists above: a colliding key's null must not erase the
      // active tab the other key named.
      const resolved = tabId && terminalTabIds.has(tabId) ? tabId : null
      activeTabIdByWorktreePath[worktreePath] =
        resolved ?? activeTabIdByWorktreePath[worktreePath] ?? null
    }
  }

  const lastVisitedAtByWorktreePath: Record<string, number> = {}
  for (const [visitKey, timestamp] of Object.entries(session.lastVisitedAtByWorktreeId ?? {})) {
    const worktreeId = isWorktreeHostIdentity(visitKey)
      ? getWorktreeIdFromHostIdentity(visitKey)
      : visitKey
    const executionHostId = isWorktreeHostIdentity(visitKey)
      ? (visitKey.slice(0, visitKey.indexOf('|')) as ExecutionHostId)
      : undefined
    if (!options.isTargetWorktree(worktreeId, executionHostId)) {
      continue
    }
    const worktreePath = worktreePathFromId(worktreeId)
    if (worktreePath) {
      // Why max: a bare legacy key and its host-qualified twin collapse onto one path.
      lastVisitedAtByWorktreePath[worktreePath] = Math.max(
        lastVisitedAtByWorktreePath[worktreePath] ?? 0,
        timestamp
      )
    }
  }

  const defaultTerminalTabsAppliedByWorktreePath: Record<string, true> = {}
  for (const worktreeId of Object.keys(session.defaultTerminalTabsAppliedByWorktreeId ?? {})) {
    if (!options.isTargetWorktree(worktreeId)) {
      continue
    }
    const worktreePath = worktreePathFromId(worktreeId)
    if (worktreePath) {
      defaultTerminalTabsAppliedByWorktreePath[worktreePath] = true
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
      ?.filter((worktreeId) => options.isTargetWorktree(worktreeId))
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
    lastVisitedAtByWorktreePath,
    defaultTerminalTabsAppliedByWorktreePath
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
      if (tabs.length > 0) {
        options.onUnplacedTerminalTabs?.(worktreePath, tabs.length)
      }
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
      const key = options.executionHostId
        ? composeWorktreeHostIdentity(options.executionHostId, worktreeId)
        : worktreeId
      lastVisitedAtByWorktreeId[key] = timestamp
    }
  }

  const defaultTerminalTabsAppliedByWorktreeId: Record<string, true> = {}
  for (const worktreePath of Object.keys(remote.defaultTerminalTabsAppliedByWorktreePath ?? {})) {
    const worktreeId = resolvePath(worktreePath)
    if (worktreeId) {
      defaultTerminalTabsAppliedByWorktreeId[worktreeId] = true
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
    lastVisitedAtByWorktreeId,
    defaultTerminalTabsAppliedByWorktreeId
  }
}
