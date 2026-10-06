import { useAppStore } from './index'
import { useShallow } from 'zustand/react/shallow'
import type { Repo } from '../../../shared/repo-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppState } from './types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getProjectHostSetupProjectionFromState } from './project-host-setup-selector'
import {
  getIndexedAllWorktrees as getCachedAllWorktrees,
  getIndexedRepoMap as getCachedRepoMap,
  getIndexedWorktreeMap as getCachedWorktreeMap,
  getIndexedWorktreesById as getCachedWorktreesById
} from './worktree-repo-index'

export { getProjectHostSetupProjectionFromState } from './project-host-setup-selector'
export {
  resetFloatingVisibleTabCountSelectorCacheForTest,
  selectFloatingVisibleTabCount
} from './floating-workspace-panel-selector'

const EMPTY_WORKTREES: Worktree[] = []
const EMPTY_TABS: TerminalTab[] = []

const hasAnyWorktreesCache = new WeakMap<AppState['worktreesByRepo'], boolean>()

function getCachedHasAnyWorktrees(worktreesByRepo: AppState['worktreesByRepo']): boolean {
  const cached = hasAnyWorktreesCache.get(worktreesByRepo)
  if (cached !== undefined) {
    return cached
  }

  // Why: this selector sits in an always-mounted scanner. Cache by slice
  // identity so unrelated store writes do not rescan every repo bucket.
  const hasWorktrees = Object.values(worktreesByRepo).some((worktrees) => worktrees.length > 0)
  hasAnyWorktreesCache.set(worktreesByRepo, hasWorktrees)
  return hasWorktrees
}

type FloatingWorkspaceUnreadState = Pick<
  AppState,
  'tabsByWorktree' | 'unreadTerminalTabs' | 'unreadAgentCompletionPanes'
>
type FloatingWorkspaceUnreadCache = {
  tabs: NonNullable<AppState['tabsByWorktree'][string]>
  unreadTerminalTabs: AppState['unreadTerminalTabs']
  unreadAgentCompletionPanes: AppState['unreadAgentCompletionPanes']
  hasUnread: boolean
}

let floatingWorkspaceUnreadCache: FloatingWorkspaceUnreadCache | null = null

/**
 * True when any terminal tab in the floating workspace has an unacknowledged
 * bell or agent completion — the signal behind the launcher attention dot.
 *
 * Derives from the existing "show until interact" unread maps rather than a
 * bespoke flag, so it clears exactly when the user engages with (or closes) the
 * offending tab, and reflects only tabs that still exist (stale map entries for
 * removed tabs cannot light it). Bells mark `unreadTerminalTabs[tabId]`;
 * completions mark `unreadAgentCompletionPanes[paneKey]` — both ungated.
 *
 * The launcher and floating overlay both stay mounted. Cache their shared
 * reference projection so the second consumer and unrelated Zustand writes
 * return in O(1) without repeating either unread-map scan.
 */
export function selectFloatingWorkspaceHasUnread(state: FloatingWorkspaceUnreadState): boolean {
  const tabs = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TABS
  const cached = floatingWorkspaceUnreadCache
  if (
    cached &&
    cached.tabs === tabs &&
    cached.unreadTerminalTabs === state.unreadTerminalTabs &&
    cached.unreadAgentCompletionPanes === state.unreadAgentCompletionPanes
  ) {
    return cached.hasUnread
  }

  let hasUnread = false
  if (tabs.length > 0) {
    const floatingTabIds = new Set<string>()
    for (const tab of tabs) {
      if (state.unreadTerminalTabs[tab.id]) {
        hasUnread = true
        break
      }
      floatingTabIds.add(tab.id)
    }
    if (!hasUnread) {
      // paneKey is `${tabId}:${leafId}` and tabIds never contain ":", so the
      // prefix up to the first ":" is the owning tab id.
      for (const paneKey of Object.keys(state.unreadAgentCompletionPanes)) {
        const separatorIndex = paneKey.indexOf(':')
        const tabId = separatorIndex === -1 ? paneKey : paneKey.slice(0, separatorIndex)
        if (floatingTabIds.has(tabId)) {
          hasUnread = true
          break
        }
      }
    }
  }

  floatingWorkspaceUnreadCache = {
    tabs,
    unreadTerminalTabs: state.unreadTerminalTabs,
    unreadAgentCompletionPanes: state.unreadAgentCompletionPanes,
    hasUnread
  }
  return hasUnread
}

export function resetFloatingWorkspaceUnreadSelectorCacheForTest(): void {
  floatingWorkspaceUnreadCache = null
}

export function getAllWorktreesFromState(state: Pick<AppState, 'worktreesByRepo'>): Worktree[] {
  return getCachedAllWorktrees(state.worktreesByRepo)
}

export function getWorktreeMapFromState(
  state: Pick<AppState, 'worktreesByRepo'>
): Map<string, Worktree> {
  return getCachedWorktreeMap(state.worktreesByRepo)
}

/**
 * The row for one id on one host (STA-4343). Prefer this over the id-keyed map
 * anywhere the caller already knows which host's row it is acting on — the map
 * keeps a single row per id and cannot represent a two-host collision.
 */
export function getWorktreeOnHostFromState(
  state: Pick<AppState, 'worktreesByRepo'>,
  worktreeId: string,
  hostId: ExecutionHostId | undefined
): Worktree | undefined {
  const rows = getCachedWorktreesById(state.worktreesByRepo, worktreeId)
  return hostId ? rows.find((row) => row.hostId === hostId) : rows[0]
}

export function getHasAnyWorktreesFromState(state: Pick<AppState, 'worktreesByRepo'>): boolean {
  return getCachedHasAnyWorktrees(state.worktreesByRepo)
}

export function getRepoMapFromState(state: Pick<AppState, 'repos'>): Map<string, Repo> {
  return getCachedRepoMap(state.repos)
}

// ─── Repos ──────────────────────────────────────────────────────────
export const useRepos = () => useAppStore((s) => s.repos)
export const useActiveRepo = () =>
  useAppStore(useShallow((s) => selectRepoByIdForActiveWorkspace(s, s.activeRepoId)))
export const useRepoMap = () => useAppStore((s) => getCachedRepoMap(s.repos))

type ActiveWorkspaceRepoState = Pick<
  AppState,
  'repos' | 'activeRepoId' | 'activeWorkspaceExecutionHostId'
>

// Why: mirrors getIndexedRepoMap above — the host-scoped branch re-filtered every
// repo on each store write even though its answer only moves when `repos` or the
// active workspace host does.
const activeWorkspaceRepoCache = new WeakMap<AppState['repos'], Map<string, Repo | null>>()

function resolveRepoOnActiveWorkspaceHost(
  state: ActiveWorkspaceRepoState,
  repoId: string,
  activeWorkspaceExecutionHostId: ExecutionHostId
): Repo | null {
  const repoCandidates = state.repos.filter((candidate) => candidate.id === repoId)
  const hostMatch = repoCandidates.find(
    (candidate) => getRepoExecutionHostId(candidate) === activeWorkspaceExecutionHostId
  )
  if (hostMatch) {
    return hostMatch
  }
  // Why: withRepoHostOwnership keeps a paired-hub worktree on its own SSH host while the repo
  // stays hub-owned, so that one mismatch still names the right repo; every other stays closed.
  if (parseExecutionHostId(activeWorkspaceExecutionHostId)?.kind !== 'ssh') {
    return null
  }
  const pairedHubRepos = repoCandidates.filter(
    (candidate) => parseExecutionHostId(getRepoExecutionHostId(candidate))?.kind === 'runtime'
  )
  return pairedHubRepos.length === 1 ? pairedHubRepos[0] : null
}

export function selectRepoByIdForActiveWorkspace(
  state: ActiveWorkspaceRepoState,
  repoId: string | null
): Repo | null {
  if (!repoId) {
    return null
  }
  const repo = getCachedRepoMap(state.repos).get(repoId) ?? null
  const activeWorkspaceExecutionHostId = state.activeWorkspaceExecutionHostId
  if (repoId !== state.activeRepoId || !activeWorkspaceExecutionHostId) {
    return repo
  }
  // The branch below only fires for the active repo, so the host id fully keys it.
  let byHost = activeWorkspaceRepoCache.get(state.repos)
  if (!byHost) {
    byHost = new Map()
    activeWorkspaceRepoCache.set(state.repos, byHost)
  }
  const cacheKey = `${activeWorkspaceExecutionHostId}\u0000${repoId}`
  const cached = byHost.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const resolved = resolveRepoOnActiveWorkspaceHost(state, repoId, activeWorkspaceExecutionHostId)
  byHost.set(cacheKey, resolved)
  return resolved
}

export const useRepoById = (repoId: string | null) =>
  useAppStore((s) => selectRepoByIdForActiveWorkspace(s, repoId))
export const useProjectHostSetupProjection = () =>
  useAppStore((s) => getProjectHostSetupProjectionFromState(s))

// ─── Worktrees ──────────────────────────────────────────────────────
export const useActiveWorktreeId = () => useAppStore((s) => s.activeWorktreeId)
export const useWorktreesForRepo = (repoId: string | null) =>
  useAppStore((s) => (repoId ? (s.worktreesByRepo[repoId] ?? EMPTY_WORKTREES) : EMPTY_WORKTREES))
export const useAllWorktrees = () => useAppStore((s) => getCachedAllWorktrees(s.worktreesByRepo))
export const useWorktreeMap = () => useAppStore((s) => getCachedWorktreeMap(s.worktreesByRepo))
export const useWorktreeById = (worktreeId: string | null, executionHostId?: ExecutionHostId) =>
  useAppStore((s) =>
    worktreeId
      ? (s.getKnownWorktreeById(
          worktreeId,
          executionHostId ??
            (worktreeId === s.activeWorktreeId
              ? (s.activeWorkspaceExecutionHostId ?? undefined)
              : undefined)
        ) ?? null)
      : null
  )
export const useActiveWorktree = () => {
  const activeWorktreeId = useActiveWorktreeId()
  return useAppStore((s) =>
    activeWorktreeId
      ? (s.getKnownWorktreeById(activeWorktreeId, s.activeWorkspaceExecutionHostId ?? undefined) ??
        null)
      : null
  )
}
