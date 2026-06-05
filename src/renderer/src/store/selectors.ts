import { useAppStore } from './index'
import { useShallow } from 'zustand/react/shallow'
import type { Repo, Worktree, TerminalTab } from '../../../shared/types'
import type { AppState } from './types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

const EMPTY_WORKTREES: Worktree[] = []
const EMPTY_TABS: TerminalTab[] = []
const EMPTY_BROWSER_TABS: NonNullable<AppState['browserTabsByWorktree'][string]> = []
const EMPTY_UNIFIED_TABS: NonNullable<AppState['unifiedTabsByWorktree'][string]> = []

type WorktreeSnapshot = {
  allWorktrees: Worktree[]
  worktreeMap: Map<string, Worktree>
}
type FloatingVisibleTabCountState = Pick<
  AppState,
  'browserTabsByWorktree' | 'openFiles' | 'tabsByWorktree' | 'unifiedTabsByWorktree'
>
type FloatingVisibleTabCountCache = {
  terminalTabs: NonNullable<AppState['tabsByWorktree'][string]>
  browserTabs: NonNullable<AppState['browserTabsByWorktree'][string]>
  openFiles: AppState['openFiles']
  unifiedTabs: NonNullable<AppState['unifiedTabsByWorktree'][string]>
  count: number
}

// Why: Zustand reruns selectors on every write, so hot-path flatten/map work
// needs cross-render caching. WeakMap ties each snapshot to the store slice ref
// without pinning old test/dev instances in memory once that slice is replaced.
const worktreeSnapshotCache = new WeakMap<AppState['worktreesByRepo'], WorktreeSnapshot>()
const hasAnyWorktreesCache = new WeakMap<AppState['worktreesByRepo'], boolean>()
const repoMapCache = new WeakMap<AppState['repos'], Map<string, Repo>>()
let floatingVisibleTabCountCache: FloatingVisibleTabCountCache | null = null

function getWorktreeSnapshot(worktreesByRepo: AppState['worktreesByRepo']): WorktreeSnapshot {
  const cachedSnapshot = worktreeSnapshotCache.get(worktreesByRepo)
  if (cachedSnapshot) {
    return cachedSnapshot
  }

  // Why: a race between createWorktree (which appends) and fetchWorktrees
  // (which replaces) can produce duplicate entries for the same worktree ID
  // within a single repo's array. Deduplicating here prevents React from
  // seeing duplicate keys, which can corrupt terminal DOM containers.
  const worktreeMap = new Map<string, Worktree>()
  // Why: this selector sits on hot Zustand subscription paths; avoid building
  // a transient flattened array just to populate the snapshot cache.
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      worktreeMap.set(worktree.id, worktree)
    }
  }
  const allWorktrees = Array.from(worktreeMap.values())

  const snapshot = { allWorktrees, worktreeMap }
  worktreeSnapshotCache.set(worktreesByRepo, snapshot)
  return snapshot
}

function getCachedAllWorktrees(worktreesByRepo: AppState['worktreesByRepo']): Worktree[] {
  return getWorktreeSnapshot(worktreesByRepo).allWorktrees
}

function getCachedWorktreeMap(worktreesByRepo: AppState['worktreesByRepo']): Map<string, Worktree> {
  const snapshot = worktreeSnapshotCache.get(worktreesByRepo)
  if (snapshot) {
    return snapshot.worktreeMap
  }
  return getWorktreeSnapshot(worktreesByRepo).worktreeMap
}

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

function getCachedRepoMap(repos: AppState['repos']): Map<string, Repo> {
  const cachedMap = repoMapCache.get(repos)
  if (cachedMap) {
    return cachedMap
  }

  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  repoMapCache.set(repos, repoMap)
  return repoMap
}

export function selectFloatingVisibleTabCount(state: FloatingVisibleTabCountState): number {
  const terminalTabs = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TABS
  const browserTabs =
    state.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_BROWSER_TABS
  const unifiedTabs =
    state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_UNIFIED_TABS
  const cached = floatingVisibleTabCountCache
  if (
    cached &&
    cached.terminalTabs === terminalTabs &&
    cached.browserTabs === browserTabs &&
    cached.openFiles === state.openFiles &&
    cached.unifiedTabs === unifiedTabs
  ) {
    return cached.count
  }

  const terminalIds = new Set<string>()
  for (const tab of terminalTabs) {
    terminalIds.add(tab.id)
  }
  const browserIds = new Set<string>()
  for (const tab of browserTabs) {
    browserIds.add(tab.id)
  }
  const editorIds = new Set<string>()
  for (const file of state.openFiles) {
    if (file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      editorIds.add(file.id)
    }
  }

  let count = 0
  for (const tab of unifiedTabs) {
    if (tab.contentType === 'terminal') {
      count += terminalIds.has(tab.entityId) ? 1 : 0
    } else if (tab.contentType === 'browser') {
      count += browserIds.has(tab.entityId) ? 1 : 0
    } else {
      count += editorIds.has(tab.entityId) ? 1 : 0
    }
  }

  floatingVisibleTabCountCache = {
    terminalTabs,
    browserTabs,
    openFiles: state.openFiles,
    unifiedTabs,
    count
  }
  return count
}

export function resetFloatingVisibleTabCountSelectorCacheForTest(): void {
  floatingVisibleTabCountCache = null
}

export function getAllWorktreesFromState(state: Pick<AppState, 'worktreesByRepo'>): Worktree[] {
  return getCachedAllWorktrees(state.worktreesByRepo)
}

export function getWorktreeMapFromState(
  state: Pick<AppState, 'worktreesByRepo'>
): Map<string, Worktree> {
  return getCachedWorktreeMap(state.worktreesByRepo)
}

export function getHasAnyWorktreesFromState(state: Pick<AppState, 'worktreesByRepo'>): boolean {
  return getCachedHasAnyWorktrees(state.worktreesByRepo)
}

export function getRepoMapFromState(state: Pick<AppState, 'repos'>): Map<string, Repo> {
  return getCachedRepoMap(state.repos)
}

// ─── Repos ──────────────────────────────────────────────────────────
export const useRepos = () => useAppStore((s) => s.repos)
export const useActiveRepoId = () => useAppStore((s) => s.activeRepoId)
export const useActiveRepo = () =>
  useAppStore(useShallow((s) => s.repos.find((r) => r.id === s.activeRepoId) ?? null))
export const useRepoMap = () => useAppStore((s) => getCachedRepoMap(s.repos))
export const useRepoById = (repoId: string | null) =>
  useAppStore((s) => (repoId ? (getCachedRepoMap(s.repos).get(repoId) ?? null) : null))

// ─── Worktrees ──────────────────────────────────────────────────────
export const useActiveWorktreeId = () => useAppStore((s) => s.activeWorktreeId)
export const useWorktreesForRepo = (repoId: string | null) =>
  useAppStore((s) => (repoId ? (s.worktreesByRepo[repoId] ?? EMPTY_WORKTREES) : EMPTY_WORKTREES))
export const useAllWorktrees = () => useAppStore((s) => getCachedAllWorktrees(s.worktreesByRepo))
export const useWorktreeMap = () => useAppStore((s) => getCachedWorktreeMap(s.worktreesByRepo))
export const useWorktreeById = (worktreeId: string | null) =>
  useAppStore((s) =>
    worktreeId ? (getCachedWorktreeMap(s.worktreesByRepo).get(worktreeId) ?? null) : null
  )
export const useActiveWorktree = () => {
  const activeWorktreeId = useActiveWorktreeId()
  return useAppStore((s) =>
    activeWorktreeId ? (s.getKnownWorktreeById(activeWorktreeId) ?? null) : null
  )
}

// ─── Terminals ──────────────────────────────────────────────────────
export const useActiveTerminalTabs = () =>
  useAppStore((s) =>
    s.activeWorktreeId ? (s.tabsByWorktree[s.activeWorktreeId] ?? EMPTY_TABS) : EMPTY_TABS
  )
export const useActiveTabId = () => useAppStore((s) => s.activeTabId)

// ─── Settings ───────────────────────────────────────────────────────
export const useSettings = () => useAppStore((s) => s.settings)

// ─── UI ─────────────────────────────────────────────────────────────
export const useSidebarOpen = () => useAppStore((s) => s.sidebarOpen)
export const useSidebarWidth = () => useAppStore((s) => s.sidebarWidth)
export const useActiveView = () => useAppStore((s) => s.activeView)
export const useActiveModal = () => useAppStore((s) => s.activeModal)
export const useModalData = () => useAppStore((s) => s.modalData)
export const useGroupBy = () => useAppStore((s) => s.groupBy)
export const useSortBy = () => useAppStore((s) => s.sortBy)
export const useShowActiveOnly = () => useAppStore((s) => s.showActiveOnly)
export const useShowSleepingWorkspaces = () => useAppStore((s) => s.showSleepingWorkspaces)
export const useFilterRepoIds = () => useAppStore((s) => s.filterRepoIds)

// ─── GitHub ─────────────────────────────────────────────────────────
export const usePRCache = () => useAppStore((s) => s.prCache)
export const useIssueCache = () => useAppStore((s) => s.issueCache)
