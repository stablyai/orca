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
import { findKnownWorktreeById } from './slices/worktrees/listing/detected-worktree-meta'
import { selectWorktreesByRepo } from './workspace-record-selectors'
import { worktreeCopyOwnerKey } from './slices/worktrees/metadata/worktree-copy-review-clear'
import { findSoleHostCopy } from '../../../shared/worktree/host-qualified-identity'

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

  // Cache always-mounted scanner lookup by slice identity to avoid global rescans on unrelated writes.
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

/** Derive floating attention from live tabs’ bell/completion maps, clearing on engagement/close; stale removed-tab entries cannot light it. Share reference-cached projection across mounted launcher/overlay to avoid repeated scans. */
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
  return getCachedAllWorktrees(selectWorktreesByRepo(state))
}

export function getWorktreeMapFromState(
  state: Pick<AppState, 'worktreesByRepo'>
): Map<string, Worktree> {
  return getCachedWorktreeMap(selectWorktreesByRepo(state))
}

/**
 * The one copy of `worktreeId` on `hostId` (STA-4343). Ids repeat across hosts, so a lookup that
 * still matches two copies answers undefined instead of first-wins; callers refuse rather than guess.
 */
export function getWorktreeOnHostFromState(
  state: Pick<AppState, 'worktreesByRepo'>,
  worktreeId: string,
  hostId: ExecutionHostId | undefined
): Worktree | undefined {
  const rows = getCachedWorktreesById(selectWorktreesByRepo(state), worktreeId)
  return findSoleHostCopy(
    hostId ? rows.filter((row) => row.hostId === hostId) : rows,
    worktreeCopyOwnerKey
  )
}

export function getHasAnyWorktreesFromState(state: Pick<AppState, 'worktreesByRepo'>): boolean {
  return getCachedHasAnyWorktrees(selectWorktreesByRepo(state))
}

export function getRepoMapFromState(state: Pick<AppState, 'repos'>): Map<string, Repo> {
  return getCachedRepoMap(state.repos)
}

export const useRepos = () => useAppStore((s) => s.repos)
export const useActiveRepo = () =>
  useAppStore(useShallow((s) => selectRepoByIdForActiveWorkspace(s, s.activeRepoId)))
export const useRepoMap = () => useAppStore((s) => getCachedRepoMap(s.repos))

type ActiveWorkspaceRepoState = Pick<
  AppState,
  'repos' | 'activeRepoId' | 'activeWorkspaceExecutionHostId'
>

// Cache host-filtered repo branch by repos/active host; unrelated writes must not rescan every repo.
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
  // Paired-hub repo/SSH-worktree mismatch is valid via withRepoHostOwnership; reject other mismatches.
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

export const useActiveWorktreeId = () => useAppStore((s) => s.activeWorktreeId)
export const useWorktreesForRepo = (repoId: string | null) =>
  useAppStore((s) =>
    repoId ? (selectWorktreesByRepo(s)[repoId] ?? EMPTY_WORKTREES) : EMPTY_WORKTREES
  )
export const useAllWorktrees = () =>
  useAppStore((s) => getCachedAllWorktrees(selectWorktreesByRepo(s)))
export const useWorktreeMap = () =>
  useAppStore((s) => getCachedWorktreeMap(selectWorktreesByRepo(s)))
type WorktreeLookupHostState = Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>

// Why: worktree ids repeat across hosts, so the active id must resolve on the host the user selected.
function getWorktreeLookupHostId(
  state: WorktreeLookupHostState,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): ExecutionHostId | undefined {
  return (
    executionHostId ??
    (worktreeId === state.activeWorktreeId
      ? (state.activeWorkspaceExecutionHostId ?? undefined)
      : undefined)
  )
}

/** Catalog row (including folder and floating workspaces) read from this snapshot. */
export function selectKnownWorktreeById(
  state: WorktreeLookupHostState & Parameters<typeof findKnownWorktreeById>[0],
  worktreeId: string | null,
  executionHostId?: ExecutionHostId
): NonNullable<ReturnType<typeof findKnownWorktreeById>> | null {
  return worktreeId
    ? (findKnownWorktreeById(
        state,
        worktreeId,
        getWorktreeLookupHostId(state, worktreeId, executionHostId)
      ) ?? null)
    : null
}
export const useWorktreeById = (worktreeId: string | null, executionHostId?: ExecutionHostId) =>
  useAppStore((s) => selectKnownWorktreeById(s, worktreeId, executionHostId))
// File-list callers resolve operation ownership separately from the UI's active host.
export const useKnownWorktreeById = (worktreeId: string | null) =>
  useAppStore((s) => (worktreeId ? (findKnownWorktreeById(s, worktreeId) ?? null) : null))
export const useActiveWorktree = () => {
  const activeWorktreeId = useActiveWorktreeId()
  return useAppStore((s) =>
    activeWorktreeId
      ? (s.getKnownWorktreeById(activeWorktreeId, s.activeWorkspaceExecutionHostId ?? undefined) ??
        null)
      : null
  )
}
