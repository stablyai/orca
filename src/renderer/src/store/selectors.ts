import { useAppStore } from './index'
import { useShallow } from 'zustand/react/shallow'
import type { Repo, Worktree, TerminalTab } from '../../../shared/types'
import type { AppState } from './types'

const EMPTY_WORKTREES: Worktree[] = []
const EMPTY_TABS: TerminalTab[] = []
const EMPTY_WORKTREE_MAP = new Map<string, Worktree>()

// Why: these caches let hot selectors reuse the flattened worktree array/map
// across unrelated store updates. Zustand still runs selectors on each write,
// so avoiding repeated Object.values(...).flat() cuts wasted render work.
let cachedWorktreesByRepo: AppState['worktreesByRepo'] | null = null
let cachedAllWorktrees: Worktree[] = EMPTY_WORKTREES
let cachedWorktreeMap: Map<string, Worktree> = EMPTY_WORKTREE_MAP
let cachedRepos: AppState['repos'] | null = null
let cachedRepoMap = new Map<string, Repo>()

function getCachedAllWorktrees(worktreesByRepo: AppState['worktreesByRepo']): Worktree[] {
  if (worktreesByRepo === cachedWorktreesByRepo) {
    return cachedAllWorktrees
  }

  const allWorktrees = Object.values(worktreesByRepo).flat()
  const worktreeMap = new Map<string, Worktree>()
  for (const worktree of allWorktrees) {
    worktreeMap.set(worktree.id, worktree)
  }

  cachedWorktreesByRepo = worktreesByRepo
  cachedAllWorktrees = allWorktrees
  cachedWorktreeMap = worktreeMap
  return allWorktrees
}

function getCachedWorktreeMap(worktreesByRepo: AppState['worktreesByRepo']): Map<string, Worktree> {
  if (worktreesByRepo !== cachedWorktreesByRepo) {
    getCachedAllWorktrees(worktreesByRepo)
  }
  return cachedWorktreeMap
}

function getCachedRepoMap(repos: AppState['repos']): Map<string, Repo> {
  if (repos === cachedRepos) {
    return cachedRepoMap
  }

  cachedRepos = repos
  cachedRepoMap = new Map(repos.map((repo) => [repo.id, repo]))
  return cachedRepoMap
}

export function getAllWorktreesFromState(state: Pick<AppState, 'worktreesByRepo'>): Worktree[] {
  return getCachedAllWorktrees(state.worktreesByRepo)
}

export function getWorktreeMapFromState(
  state: Pick<AppState, 'worktreesByRepo'>
): Map<string, Worktree> {
  return getCachedWorktreeMap(state.worktreesByRepo)
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
export const useRepoById = (repoId: string | null) => {
  const repoMap = useRepoMap()
  return repoId ? (repoMap.get(repoId) ?? null) : null
}

// ─── Worktrees ──────────────────────────────────────────────────────
export const useActiveWorktreeId = () => useAppStore((s) => s.activeWorktreeId)
export const useWorktreesForRepo = (repoId: string | null) =>
  useAppStore((s) => (repoId ? (s.worktreesByRepo[repoId] ?? EMPTY_WORKTREES) : EMPTY_WORKTREES))
export const useAllWorktrees = () => useAppStore((s) => getCachedAllWorktrees(s.worktreesByRepo))
export const useWorktreeMap = () => useAppStore((s) => getCachedWorktreeMap(s.worktreesByRepo))
export const useWorktreeById = (worktreeId: string | null) => {
  const worktreeMap = useWorktreeMap()
  return worktreeId ? (worktreeMap.get(worktreeId) ?? null) : null
}
export const useActiveWorktree = () => {
  const activeWorktreeId = useActiveWorktreeId()
  return useWorktreeById(activeWorktreeId)
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
export const useSearchQuery = () => useAppStore((s) => s.searchQuery)
export const useGroupBy = () => useAppStore((s) => s.groupBy)
export const useSortBy = () => useAppStore((s) => s.sortBy)
export const useShowActiveOnly = () => useAppStore((s) => s.showActiveOnly)
export const useFilterRepoIds = () => useAppStore((s) => s.filterRepoIds)

// ─── GitHub ─────────────────────────────────────────────────────────
export const usePRCache = () => useAppStore((s) => s.prCache)
export const useIssueCache = () => useAppStore((s) => s.issueCache)
