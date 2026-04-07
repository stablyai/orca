import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'

const ERROR_TOAST_DURATION = 60_000

export type RepoSlice = {
  repos: Repo[]
  activeRepoId: string | null
  fetchRepos: () => Promise<void>
  addRepo: () => Promise<Repo | null>
  addNonGitFolder: (path: string) => Promise<Repo | null>
  removeRepo: (repoId: string) => Promise<void>
  updateRepo: (
    repoId: string,
    updates: Partial<
      Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef' | 'kind'>
    >
  ) => Promise<void>
  setActiveRepo: (repoId: string | null) => void
}

export const createRepoSlice: StateCreator<AppState, [], [], RepoSlice> = (set, get) => ({
  repos: [],
  activeRepoId: null,

  fetchRepos: async () => {
    try {
      const repos = await window.api.repos.list()
      set((s) => {
        const validRepoIds = new Set(repos.map((repo) => repo.id))
        return {
          repos,
          activeRepoId: s.activeRepoId && validRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
          filterRepoIds: s.filterRepoIds.filter((repoId) => validRepoIds.has(repoId))
        }
      })
    } catch (err) {
      console.error('Failed to fetch repos:', err)
    }
  },

  addRepo: async () => {
    try {
      const path = await window.api.repos.pickFolder()
      if (!path) {
        return null
      }
      let repo: Repo
      try {
        repo = await window.api.repos.add({ path })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!message.includes('Not a valid git repository')) {
          throw err
        }
        // Why: folder mode is a capability downgrade, not a silent fallback.
        // Show an in-app confirmation dialog so users understand that worktrees,
        // SCM, PRs, and checks will be unavailable for this root. The dialog's
        // OK handler calls addNonGitFolder to complete the flow.
        const { openModal } = get()
        openModal('confirm-non-git-folder', { folderPath: path })
        return null
      }
      const alreadyAdded = get().repos.some((r) => r.id === repo.id)
      set((s) => {
        if (s.repos.some((r) => r.id === repo.id)) {
          return s
        }
        return { repos: [...s.repos, repo] }
      })
      if (alreadyAdded) {
        toast.info('Repo already added', { description: repo.displayName })
      } else {
        toast.success(isGitRepoKind(repo) ? 'Repo added' : 'Folder added', {
          description: repo.displayName
        })
      }
      return repo
    } catch (err) {
      console.error('Failed to add repo:', err)
      const message = err instanceof Error ? err.message : String(err)
      const duration = ERROR_TOAST_DURATION
      toast.error('Failed to add repo', {
        description: message,
        duration
      })
      return null
    }
  },

  addNonGitFolder: async (path) => {
    try {
      const repo = await window.api.repos.add({ path, kind: 'folder' })
      const alreadyAdded = get().repos.some((r) => r.id === repo.id)
      set((s) => {
        if (s.repos.some((r) => r.id === repo.id)) {
          return s
        }
        return { repos: [...s.repos, repo] }
      })
      if (alreadyAdded) {
        toast.info('Repo already added', { description: repo.displayName })
      } else {
        toast.success('Folder added', { description: repo.displayName })
      }
      return repo
    } catch (err) {
      console.error('Failed to add folder:', err)
      const message = err instanceof Error ? err.message : String(err)
      toast.error('Failed to add folder', { description: message, duration: ERROR_TOAST_DURATION })
      return null
    }
  },

  removeRepo: async (repoId) => {
    try {
      await window.api.repos.remove({ repoId })

      // Kill PTYs for all worktrees belonging to this repo
      const worktreeIds = (get().worktreesByRepo[repoId] ?? []).map((w) => w.id)
      const killedTabIds = new Set<string>()
      const killedPtyIds = new Set<string>()
      for (const wId of worktreeIds) {
        const tabs = get().tabsByWorktree[wId] ?? []
        for (const tab of tabs) {
          killedTabIds.add(tab.id)
          for (const ptyId of get().ptyIdsByTabId[tab.id] ?? []) {
            killedPtyIds.add(ptyId)
            window.api.pty.kill(ptyId)
          }
        }
      }

      set((s) => {
        const nextWorktrees = { ...s.worktreesByRepo }
        delete nextWorktrees[repoId]
        const nextTabs = { ...s.tabsByWorktree }
        const nextLayouts = { ...s.terminalLayoutsByTabId }
        const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
        const nextSuppressedPtyExitIds = { ...s.suppressedPtyExitIds }
        for (const wId of worktreeIds) {
          delete nextTabs[wId]
        }
        for (const tabId of killedTabIds) {
          delete nextLayouts[tabId]
          delete nextPtyIdsByTabId[tabId]
        }
        for (const ptyId of killedPtyIds) {
          nextSuppressedPtyExitIds[ptyId] = true
        }
        // Why: editor state is worktree-scoped. Removing a repo must also
        // remove open editor files and per-worktree active-file tracking for
        // all worktrees that belonged to the repo, otherwise orphaned entries
        // would persist in the session save and pollute state.
        const worktreeIdSet = new Set(worktreeIds)
        const nextOpenFiles = s.openFiles.filter((f) => !worktreeIdSet.has(f.worktreeId))
        const nextActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
        const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        for (const wId of worktreeIds) {
          delete nextActiveFileIdByWorktree[wId]
          delete nextActiveTabTypeByWorktree[wId]
        }
        const activeFileCleared = s.activeFileId
          ? s.openFiles.some((f) => f.id === s.activeFileId && worktreeIdSet.has(f.worktreeId))
          : false
        return {
          repos: s.repos.filter((r) => r.id !== repoId),
          activeRepoId: s.activeRepoId === repoId ? null : s.activeRepoId,
          filterRepoIds: s.filterRepoIds.filter((id) => id !== repoId),
          worktreesByRepo: nextWorktrees,
          tabsByWorktree: nextTabs,
          ptyIdsByTabId: nextPtyIdsByTabId,
          suppressedPtyExitIds: nextSuppressedPtyExitIds,
          terminalLayoutsByTabId: nextLayouts,
          activeTabId: s.activeTabId && killedTabIds.has(s.activeTabId) ? null : s.activeTabId,
          openFiles: nextOpenFiles,
          activeFileIdByWorktree: nextActiveFileIdByWorktree,
          activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
          activeFileId: activeFileCleared ? null : s.activeFileId,
          activeTabType: activeFileCleared ? 'terminal' : s.activeTabType,
          sortEpoch: s.sortEpoch + 1
        }
      })
    } catch (err) {
      console.error('Failed to remove repo:', err)
    }
  },

  updateRepo: async (repoId, updates) => {
    try {
      await window.api.repos.update({ repoId, updates })
      set((s) => ({
        repos: s.repos.map((r) => (r.id === repoId ? { ...r, ...updates } : r))
      }))
    } catch (err) {
      console.error('Failed to update repo:', err)
    }
  },

  setActiveRepo: (repoId) => set({ activeRepoId: repoId })
})
