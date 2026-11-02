import type { useAppStore } from '@/store'
import { getRepoMapFromState } from '@/store/selectors'
import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { getActiveWorkspaceExecutionHostId } from '@/lib/active-workspace-host'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner,
  findIndexedRepoOwnerForHost,
  getCatalogOwnerHostId,
  resolveIndexedRepoOwner
} from '@/lib/worktree-runtime-owner-index'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

export function getPaneKeyTabId(paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    return parsed.tabId
  }

  const sepIdx = paneKey.indexOf(':')
  if (sepIdx <= 0 || sepIdx !== paneKey.lastIndexOf(':') || sepIdx === paneKey.length - 1) {
    return null
  }
  return paneKey.slice(0, sepIdx)
}

function isSuppressedPtyHint(state: StoreSnapshot, ptyId: string | null | undefined): boolean {
  return Boolean(ptyId && state.suppressedPtyExitIds?.[ptyId])
}

function hasLivePtyForWorktree(state: StoreSnapshot, candidateWorktreeId: string): boolean {
  const tabs = state.tabsByWorktree[candidateWorktreeId] ?? []
  return tabs.some((tab) =>
    (state.ptyIdsByTabId[tab.id] ?? []).some((ptyId) => !isSuppressedPtyHint(state, ptyId))
  )
}

function hasLivePtyForPaneKey(state: StoreSnapshot, paneKey: string | undefined): boolean {
  if (!paneKey) {
    return false
  }
  const tabId = getPaneKeyTabId(paneKey)
  return (
    tabId !== null &&
    (state.ptyIdsByTabId[tabId] ?? []).some((ptyId) => !isSuppressedPtyHint(state, ptyId))
  )
}

export function hasLivePtyForNotification(
  state: StoreSnapshot,
  worktreeId: string,
  paneKey: string | undefined
): boolean {
  // Between tab-list hydration states, pane-key PTY bindings still prove inactive-worktree hook liveness.
  return hasLivePtyForWorktree(state, worktreeId) || hasLivePtyForPaneKey(state, paneKey)
}

function layoutContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutContainsLeaf(node.first, leafId) || layoutContainsLeaf(node.second, leafId)
}

export function isCurrentLivePaneKey(
  state: StoreSnapshot,
  worktreeId: string,
  paneKey: string
): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }

  const tabExistsInAnotherWorktree = Object.entries(state.tabsByWorktree).some(
    ([candidateWorktreeId, tabs]) =>
      candidateWorktreeId !== worktreeId && tabs.some((tab) => tab.id === parsed.tabId)
  )
  if (tabExistsInAnotherWorktree) {
    return false
  }

  const livePtyIds = (state.ptyIdsByTabId[parsed.tabId] ?? []).filter(
    (ptyId) => !isSuppressedPtyHint(state, ptyId)
  )
  if (livePtyIds.length === 0) {
    return false
  }

  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  if (!layout) {
    return true
  }

  if (!layoutContainsLeaf(layout.root, parsed.leafId)) {
    return false
  }

  const leafPtyId = layout.ptyIdsByLeafId?.[parsed.leafId]
  // Layout can restore a leaf before its binding; tab-level PTYs still prove liveness.
  return leafPtyId === undefined || livePtyIds.includes(leafPtyId)
}

export function isCurrentKnownPaneKey(
  state: StoreSnapshot,
  worktreeId: string,
  paneKey: string
): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }

  let targetTabPtyId: string | null | undefined
  for (const [candidateWorktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === parsed.tabId)
    if (!tab) {
      continue
    }
    if (candidateWorktreeId !== worktreeId) {
      return false
    }
    targetTabPtyId = tab.ptyId
  }
  if (targetTabPtyId === undefined) {
    return false
  }

  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  if (layout?.root && !layoutContainsLeaf(layout.root, parsed.leafId)) {
    return false
  }

  const leafPtyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  // Before PTY-map hydration, accept known-tab snapshots unless explicitly suppressed; tab/leaf hints prove current inactive panes.
  const ptyHints = [targetTabPtyId, leafPtyId].filter((ptyId): ptyId is string => Boolean(ptyId))
  return ptyHints.length === 0 || ptyHints.some((ptyId) => !isSuppressedPtyHint(state, ptyId))
}

/** Resolve the workspace’s owning host: repoId::path omits host and can collide. Hydrated ownership must prove one before naming the workspace (STA-4343). */
function findWorktreeRowOnItsOwnHost(
  state: StoreSnapshot,
  worktreeId: string
): { worktree: Worktree | undefined; hostId: ExecutionHostId | null } {
  const rows = getIndexedWorktreesById(selectWorktreesByRepo(state), worktreeId)
  if (rows.length <= 1) {
    return { worktree: rows[0], hostId: null }
  }
  const hostId =
    getActiveWorkspaceExecutionHostId(state, worktreeId) ??
    getResolvedExecutionHostIdForWorktree(state, worktreeId)
  if (!hostId) {
    return { worktree: undefined, hostId: null }
  }
  // Colliding rows share the id's repo prefix, so any row names the repo to scope against.
  const matchOptions = worktreeHostMatchOptions(state, rows[0].repoId, hostId)
  return { worktree: rows.find((row) => worktreeMatchesHost(row, hostId, matchOptions)), hostId }
}

/** Name the project only with a unique repo owner; repo IDs can collide across hosts even when workspace paths differ. */
function findNotificationRepo(
  state: StoreSnapshot,
  worktreeId: string,
  repoId: string,
  hostId: ExecutionHostId | null
): Repo | undefined {
  // One owner for the id means the id-keyed map already names it, at no extra cost.
  if (resolveIndexedRepoOwner(state.repos, repoId).kind !== 'ambiguous') {
    return getRepoMapFromState(state).get(repoId)
  }
  const owningHost = hostId ?? getResolvedExecutionHostIdForWorktree(state, worktreeId)
  if (!owningHost) {
    return undefined
  }
  return findIndexedRepoOwnerForHost(state.repos, repoId, owningHost) ?? undefined
}

export function getNotificationWorkspaceLabels(
  state: StoreSnapshot,
  workspaceId: string,
  terminalTitle?: string
): { repoLabel?: string; worktreeLabel: string } {
  const scope = parseWorkspaceKey(workspaceId)
  const fallback = terminalTitle?.trim() || 'workspace'
  if (scope?.type === 'folder') {
    const folder = findIndexedFolderWorkspaceOwner(
      selectFolderWorkspaces(state),
      scope.folderWorkspaceId
    )
    // The group ID is only unique per host, so qualify it with the folder's own host.
    const group =
      folder &&
      findIndexedProjectGroupOwner(
        state.projectGroups,
        folder.projectGroupId,
        getCatalogOwnerHostId(folder)
      )
    return { repoLabel: group?.name, worktreeLabel: folder?.name || fallback }
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const { worktree, hostId } = findWorktreeRowOnItsOwnHost(state, worktreeId)
  const repo = worktree
    ? findNotificationRepo(state, worktreeId, worktree.repoId, hostId)
    : undefined
  return {
    repoLabel: repo?.displayName,
    worktreeLabel: worktree?.displayName || worktree?.branch || fallback
  }
}
