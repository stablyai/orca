import type { useAppStore } from '@/store'
import { getRepoMapFromState } from '@/store/selectors'
import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
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
import {
  getWorkspaceNotificationOrigin,
  type WorkspaceNotificationOrigin
} from '../../../../shared/workspace-notification-policy'

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
  // Why: inactive-worktree hook completions can arrive while the worktree tab
  // list is between renderer hydration states; the pane-key PTY binding is the
  // live terminal source in that path.
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
  // Why: layout hydration can briefly know the leaf before restoring its PTY
  // binding; the tab-level live PTY list remains the liveness source then.
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
  // Why: when there is no live PTY map yet, a tab/leaf PTY hint proves this is
  // an inactive-but-current pane. If hydration has no hint yet, keep accepting
  // known-tab hook snapshots; only explicit suppressed hints mean teardown.
  const ptyHints = [targetTabPtyId, leafPtyId].filter((ptyId): ptyId is string => Boolean(ptyId))
  return ptyHints.length === 0 || ptyHints.some((ptyId) => !isSuppressedPtyHint(state, ptyId))
}

/**
 * The row for this workspace on the host that owns it, plus that host when the
 * id needed one to be named.
 *
 * STA-4343: a worktree id is `repoId::path` with no host component, so two hosts
 * publish one id for two different workspaces. An id-keyed lookup answers with
 * whichever row came first, which on a collision is a coin flip — so resolve the
 * owning host instead, and name nothing when hydrated ownership cannot prove one.
 */
function findWorktreeRowOnItsOwnHost(
  state: StoreSnapshot,
  worktreeId: string
): { worktree: Worktree | undefined; hostId: ExecutionHostId | null } {
  const rows = getIndexedWorktreesById(state.worktreesByRepo, worktreeId)
  if (rows.length <= 1) {
    return { worktree: rows[0], hostId: null }
  }
  const hostId = getResolvedExecutionHostIdForWorktree(state, worktreeId)
  if (!hostId) {
    return { worktree: undefined, hostId: null }
  }
  // Colliding rows share the id's repo prefix, so any row names the repo to scope against.
  const matchOptions = worktreeHostMatchOptions(state, rows[0].repoId, hostId)
  return { worktree: rows.find((row) => worktreeMatchesHost(row, hostId, matchOptions)), hostId }
}

/**
 * The project for this worktree, named only when one host owns the repo id.
 *
 * A repo id is registered per host, so the same id can name two projects (see
 * `src/main/persistence-duplicate-repo-id-host-scope.test.ts`). That collision is
 * independent of the worktree-id collision above: two hosts can hold repo `dup` at
 * different paths, giving unique worktree ids whose repo lookup is still ambiguous.
 */
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
): { repoLabel?: string; worktreeLabel: string; workspaceOrigin?: WorkspaceNotificationOrigin } {
  const scope = parseWorkspaceKey(workspaceId)
  const fallback = terminalTitle?.trim() || 'workspace'
  if (scope?.type === 'folder') {
    const folder = findIndexedFolderWorkspaceOwner(state.folderWorkspaces, scope.folderWorkspaceId)
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
  const workspaceOrigin = getWorkspaceNotificationOrigin(worktree)
  return {
    repoLabel: repo?.displayName,
    ...(workspaceOrigin !== 'other' ? { workspaceOrigin } : {}),
    worktreeLabel: worktree?.displayName || worktree?.branch || fallback
  }
}
