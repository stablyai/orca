import { parseExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import { buildMirroredTerminalTabs } from './web-session-tabs-sync/terminal-build'
import { indexMirroredTerminalSurfaces } from './web-session-tabs-sync/mirrored-terminal-handle-index'
import { isFrameDrawnServerWorkspace } from './web-session-tabs-sync/frame-drawn-server-workspaces'

export function getTerminalHostAliasesFor(
  state: WebSessionTabsSyncState,
  environmentId: string,
  worktreeId: string
) {
  return Object.values(state.tabsByWorktree)
    .flat()
    .filter((tab) => {
      const alias = tab.hostTerminalAlias
      const host = parseExecutionHostId(alias?.executionHostId)
      return (
        host?.kind === 'runtime' &&
        host.environmentId === environmentId &&
        alias?.worktreeId === worktreeId
      )
    })
}

// Why: an independently mirrored workspace must keep receiving ordinary snapshots beside its aliases.
export function hasIndependentWorkspacePresence(
  state: WebSessionTabsSyncState,
  environmentId: string,
  worktreeId: string
): boolean {
  const rows = state.tabsByWorktree[worktreeId]
  const entries = state.unifiedTabsByWorktree[worktreeId]
  return (
    (rows !== undefined && (!rows.length || rows.some((row) => !row.hostTerminalAlias))) ||
    (entries !== undefined &&
      (!entries.length ||
        entries.some(
          (entry) =>
            entry.contentType !== 'terminal' ||
            !rows?.find((row) => row.id === entry.entityId)?.hostTerminalAlias
        ))) ||
    state.browserTabsByWorktree[worktreeId] !== undefined ||
    state.openFiles.some((file) => file.worktreeId === worktreeId) ||
    isFrameDrawnServerWorkspace(environmentId, worktreeId)
  )
}

export function reconcileTerminalHostAliases(
  state: WebSessionTabsSyncState,
  patch: WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const aliases = getTerminalHostAliasesFor(state, environmentId, snapshot.worktree)
  if (!aliases.length) {
    return patch
  }
  indexMirroredTerminalSurfaces(environmentId, snapshot)
  const next = { ...state, ...patch }
  const mirrors = new Map(
    buildMirroredTerminalTabs(
      snapshot,
      environmentId,
      new Map(aliases.map((tab) => [tab.id, tab])),
      next.terminalLayoutsByTabId,
      next.ptyIdsByTabId,
      0,
      Date.now()
    ).map((mirror) => [mirror.tab.id, mirror])
  )
  const tabsByWorktree = { ...next.tabsByWorktree }
  const unifiedTabsByWorktree = { ...next.unifiedTabsByWorktree }
  const terminalLayoutsByTabId = { ...next.terminalLayoutsByTabId }
  for (const alias of aliases) {
    const mirror = mirrors.get(alias.id)
    const tab = {
      ...alias,
      ...mirror?.tab,
      worktreeId: alias.worktreeId,
      hostTerminalAlias: alias.hostTerminalAlias,
      hostTerminalAliasGone: !mirror,
      createdAt: alias.createdAt,
      ptyId: mirror?.tab.ptyId ?? null
    }
    const rows = tabsByWorktree[alias.worktreeId] ?? []
    tabsByWorktree[alias.worktreeId] = rows.some((row) => row.id === alias.id)
      ? rows.map((row) => (row.id === alias.id ? tab : row))
      : [...rows, tab]
    const entry = state.unifiedTabsByWorktree[alias.worktreeId]?.find(
      (row) => row.entityId === alias.id
    )
    if (entry) {
      const entries = unifiedTabsByWorktree[alias.worktreeId] ?? []
      const updated = { ...entry, label: tab.title }
      unifiedTabsByWorktree[alias.worktreeId] = entries.some((row) => row.id === entry.id)
        ? entries.map((row) => (row.id === entry.id ? updated : row))
        : [...entries, updated]
    }
    const layout = mirror?.layout ?? state.terminalLayoutsByTabId[alias.id]
    if (layout) {
      terminalLayoutsByTabId[alias.id] = layout
    }
  }
  return { ...patch, tabsByWorktree, unifiedTabsByWorktree, terminalLayoutsByTabId }
}
